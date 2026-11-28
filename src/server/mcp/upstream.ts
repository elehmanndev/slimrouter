import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { getServer, type McpServer } from "./registry";

/**
 * One live client per upstream MCP server, shared by every downstream session. Started lazily on
 * first use, restarted after the process or connection dies, closed when the server is edited
 * or disabled. Stdio servers run as child processes of slimrouter.
 */

export interface UpstreamStatus {
  name: string;
  state: "idle" | "connecting" | "ready" | "error";
  error: string | null;
  tools: number;
  connectedAt: string | null;
  version: string | null;
}

interface Live {
  client: Client;
  tools: Tool[];
  configStamp: string;
  connectedAt: string;
}

const g = globalThis as typeof globalThis & {
  __slimMcp?: { live: Map<string, Live>; connecting: Map<string, Promise<Live>>; errors: Map<string, string>; stderr: Map<string, string[]> };
};
const state = (g.__slimMcp ??= { live: new Map(), connecting: new Map(), errors: new Map(), stderr: new Map() });

const STDERR_LINES = 80;

// The SDK's default child environment is only HOME, PATH, SHELL, TERM, USER and LOGNAME. These are
// added so npx/uvx reuse the image's caches under /data and children keep the host's time zone and
// locale. A server's own env still wins.
const INHERITED = ["TZ", "LANG", "LC_ALL", "XDG_CACHE_HOME", "NPM_CONFIG_CACHE", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR", "PLAYWRIGHT_BROWSERS_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

export function childEnv(own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const k of INHERITED) if (process.env[k]) env[k] = process.env[k]!;
  return { ...env, ...own };
}
const stamp = (s: McpServer) => `${s.transport}:${JSON.stringify(s.config)}:${s.enabled}`;

function transportFor(s: McpServer) {
  if (s.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(s.config.url), { requestInit: { headers: s.config.headers } });
  }
  const t = new StdioClientTransport({
    command: s.config.command,
    args: s.config.args,
    env: childEnv(s.config.env),
    cwd: s.config.cwd,
    stderr: "pipe",
  });
  const lines: string[] = [];
  state.stderr.set(s.name, lines);
  t.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      lines.push(line.slice(0, 500));
      if (lines.length > STDERR_LINES) lines.shift();
    }
  });
  return t;
}

async function connect(s: McpServer): Promise<Live> {
  const client = new Client({ name: "slimrouter", version: "1" }, { capabilities: {} });
  const transport = transportFor(s);
  const name = s.name;
  client.onclose = () => {
    const cur = state.live.get(name);
    if (cur?.client === client) state.live.delete(name);
  };
  await client.connect(transport, { timeout: Math.min(s.config.timeoutMs, 120_000) });
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 60_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const live: Live = { client, tools, configStamp: stamp(s), connectedAt: new Date().toISOString() };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      const fresh = await client.listTools(undefined, { timeout: 60_000 });
      live.tools = fresh.tools;
    } catch {
      /* keep the previous list */
    }
  });
  return live;
}

/** A ready client for a server, connecting if needed. Throws when the server is unknown, disabled or down. */
export async function getUpstream(name: string): Promise<Live> {
  const s = getServer(name);
  if (!s || !s.enabled) throw new Error(`MCP server ${name} is not available`);
  const cur = state.live.get(name);
  if (cur && cur.configStamp === stamp(s)) return cur;
  if (cur) await closeUpstream(name);
  const pending = state.connecting.get(name);
  if (pending) return pending;
  const task = connect(s)
    .then((live) => {
      state.live.set(name, live);
      state.errors.delete(name);
      return live;
    })
    .catch((e: Error) => {
      state.errors.set(name, e.message.slice(0, 500));
      throw e;
    })
    .finally(() => state.connecting.delete(name));
  state.connecting.set(name, task);
  return task;
}

export async function closeUpstream(name: string) {
  const cur = state.live.get(name);
  state.live.delete(name);
  if (cur) await cur.client.close().catch(() => undefined);
}

/** Tools of a server after the per-tool switches in its config. */
export function enabledTools(s: McpServer, tools: Tool[]): Tool[] {
  return tools.filter((t) => s.config.tools[t.name]?.enabled !== false);
}

export async function callUpstream(name: string, tool: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult> {
  const s = getServer(name);
  if (!s) throw new Error(`MCP server ${name} is not available`);
  const live = await getUpstream(name);
  const result = await live.client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: s.config.timeoutMs,
    resetTimeoutOnProgress: true,
    signal,
  });
  return result as CallToolResult;
}

export function upstreamStatus(name: string): UpstreamStatus {
  const live = state.live.get(name);
  const s = getServer(name);
  return {
    name,
    state: live ? "ready" : state.connecting.has(name) ? "connecting" : state.errors.has(name) ? "error" : "idle",
    error: state.errors.get(name) ?? null,
    tools: live && s ? enabledTools(s, live.tools).length : 0,
    connectedAt: live?.connectedAt ?? null,
    version: live?.client.getServerVersion()?.version ?? null,
  };
}

export function upstreamTools(name: string): Tool[] | null {
  return state.live.get(name)?.tools ?? null;
}

export function upstreamStderr(name: string): string[] {
  return [...(state.stderr.get(name) || [])];
}
