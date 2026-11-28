import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { keyAllowsMcp, type ApiKey } from "../apikeys";
import { getServer, listServers } from "./registry";
import { callUpstream, enabledTools, getUpstream } from "./upstream";
import { recordMcpCall } from "./log";

/**
 * Downstream MCP endpoint. Two shapes, both Streamable HTTP:
 *   /mcp            every server the key may reach, tools named "<server>__<tool>"
 *   /mcp/<server>   one server, original tool names (drop-in for an mcphub URL)
 * Each session gets its own Server and transport; upstream clients are shared.
 */

export const SEP = "__";
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  keyId: string;
  scope: string | null;
  lastSeen: number;
}

const g = globalThis as typeof globalThis & { __slimMcpSessions?: Map<string, Session>; __slimMcpSweep?: boolean };
const sessions = (g.__slimMcpSessions ??= new Map());
if (!g.__slimMcpSweep) {
  g.__slimMcpSweep = true;
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) void s.transport.close().catch(() => undefined).finally(() => sessions.delete(id));
  }, 60_000).unref?.();
}

/** Servers a key reaches through this endpoint: enabled ones it is allowed, or just the scoped one. */
export function reachableServers(key: ApiKey, scope: string | null): string[] {
  const names = listServers({ enabledOnly: true }).map((s) => s.name);
  return names.filter((n) => keyAllowsMcp(key, n) && (!scope || n === scope));
}

async function collectTools(key: ApiKey, scope: string | null): Promise<Tool[]> {
  const out: Tool[] = [];
  const names = reachableServers(key, scope);
  const results = await Promise.allSettled(names.map(async (n) => ({ n, live: await getUpstream(n) })));
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const s = getServer(r.value.n);
    if (!s) continue;
    for (const t of enabledTools(s, r.value.live.tools)) {
      out.push(scope ? t : { ...t, name: `${s.name}${SEP}${t.name}`, description: t.description ? `[${s.name}] ${t.description}` : `[${s.name}]` });
    }
  }
  return out;
}

export function splitToolName(name: string, scope: string | null): { server: string; tool: string } | null {
  if (scope) return { server: scope, tool: name };
  const i = name.indexOf(SEP);
  if (i <= 0) return null;
  return { server: name.slice(0, i), tool: name.slice(i + SEP.length) };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function buildServer(key: ApiKey, scope: string | null): Server {
  const server = new Server({ name: scope ? `slimrouter/${scope}` : "slimrouter", version: "1" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await collectTools(key, scope) }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const target = splitToolName(req.params.name, scope);
    if (!target) return errorResult(`Unknown tool ${req.params.name}`);
    const s = getServer(target.server);
    if (!s || !s.enabled || !keyAllowsMcp(key, s.name)) return errorResult(`This key may not use MCP server ${target.server}`);
    if (s.config.tools[target.tool]?.enabled === false) return errorResult(`Tool ${target.tool} is disabled on ${s.name}`);
    const started = Date.now();
    try {
      const result = await callUpstream(s.name, target.tool, req.params.arguments as Record<string, unknown> | undefined, extra.signal);
      recordMcpCall({ server: s.name, tool: target.tool, apiKeyId: key.id, ok: !result.isError, durationMs: Date.now() - started, error: null });
      return result;
    } catch (e) {
      const message = (e as Error).message;
      recordMcpCall({ server: s.name, tool: target.tool, apiKeyId: key.id, ok: false, durationMs: Date.now() - started, error: message });
      return errorResult(`${s.name}: ${message}`);
    }
  });
  return server;
}

/** Handle one HTTP request on /mcp or /mcp/<scope> for an authenticated key. */
export async function handleMcpRequest(req: Request, key: ApiKey, scope: string | null): Promise<Response> {
  if (scope && !reachableServers(key, scope).length) {
    return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: `MCP server ${scope} is not available to this key` }, id: null }, { status: 404 });
  }
  const sid = req.headers.get("mcp-session-id");
  if (sid) {
    const s = sessions.get(sid);
    if (!s) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }, { status: 404 });
    if (s.keyId !== key.id || s.scope !== scope) return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session belongs to another key" }, id: null }, { status: 403 });
    s.lastSeen = Date.now();
    return s.transport.handleRequest(req);
  }
  if (req.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing mcp-session-id" }, id: null }, { status: 400 });
  const server = buildServer(key, scope);
  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, keyId: key.id, scope, lastSeen: Date.now() });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  return transport.handleRequest(req);
}

export function sessionCount(): number {
  return sessions.size;
}
