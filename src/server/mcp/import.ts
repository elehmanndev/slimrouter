import { z } from "zod";
import { NAME_RE, getServer, upsertServer, type ServerInput } from "./registry";

/**
 * Import an mcphub mcp_settings.json. Servers keep their names, so /mcp/<name> on slimrouter is a
 * drop-in for https://mcphub.../mcp/<name>. Stdio servers are imported with their command, args and
 * env; mcphub's in-container paths (/mcp-servers, /app/data, /vaults) are mapped with pathMap.
 * Bearer keys become a suggestion for each client key's MCP list (by name), not keys: mcphub stores
 * only hashes.
 */

const mcphubServer = z
  .object({
    type: z.string().optional(),
    enabled: z.boolean().optional(),
    description: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    tools: z.record(z.string(), z.object({ enabled: z.boolean() }).passthrough()).optional(),
    options: z.object({ timeout: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

const mcphubFile = z
  .object({
    mcpServers: z.record(z.string(), mcphubServer),
    bearerKeys: z.array(z.object({ name: z.string(), enabled: z.boolean().optional(), accessType: z.string().optional(), allowedServers: z.array(z.string()).optional() }).passthrough()).optional(),
  })
  .passthrough();

export interface ImportPlanItem {
  name: string;
  action: "create" | "update" | "skip";
  transport: "http" | "stdio" | null;
  enabled: boolean;
  reason: string | null;
  input: ServerInput | null;
}

export interface ImportPlan {
  servers: ImportPlanItem[];
  keyHints: { name: string; servers: string[] | "all" }[];
}

/** Replace a container path prefix wherever it appears as a whole path segment (start, after a space, or after =). */
function mapPath(v: string, pathMap: Record<string, string>): string {
  let out = v;
  for (const [from, to] of Object.entries(pathMap)) {
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
    out = out.replace(new RegExp(`(^|[\\s=])${esc}(?=/|\\s|$)`, "g"), (_m, pre: string) => pre + to);
  }
  return out;
}

export function planMcphubImport(raw: unknown, opts: { pathMap?: Record<string, string>; skip?: string[] } = {}): ImportPlan {
  const file = mcphubFile.parse(raw);
  const pathMap = opts.pathMap || {};
  const skip = new Set(opts.skip || []);
  const servers: ImportPlanItem[] = [];
  for (const [name, s] of Object.entries(file.mcpServers)) {
    const base = { name, enabled: s.enabled !== false };
    if (!NAME_RE.test(name)) {
      servers.push({ ...base, action: "skip", transport: null, reason: "name not allowed (lowercase letters, digits, dashes)", input: null });
      continue;
    }
    if (skip.has(name)) {
      servers.push({ ...base, action: "skip", transport: null, reason: "skipped on request", input: null });
      continue;
    }
    const tools = Object.fromEntries(Object.entries(s.tools || {}).map(([k, v]) => [k, { enabled: v.enabled }]));
    const timeoutMs = Math.min(Math.max(s.options?.timeout ?? 120_000, 1000), 3_600_000);
    const type = s.type || (s.url ? "streamable-http" : "stdio");
    let input: ServerInput | null = null;
    let reason: string | null = null;
    if (type === "streamable-http" || type === "http") {
      if (!s.url) reason = "http server without url";
      else input = { name, transport: "http", description: s.description ?? null, enabled: base.enabled, config: { url: s.url, headers: s.headers || {}, tools, timeoutMs } };
    } else if (type === "stdio") {
      if (!s.command) reason = "stdio server without command";
      else
        input = {
          name,
          transport: "stdio",
          description: s.description ?? null,
          enabled: base.enabled,
          config: {
            command: mapPath(s.command, pathMap),
            args: (s.args || []).map((a) => mapPath(a, pathMap)),
            env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, mapPath(v, pathMap)])),
            tools,
            timeoutMs,
          },
        };
    } else reason = `transport ${type} not supported`;
    servers.push({ ...base, action: input ? (getServer(name) ? "update" : "create") : "skip", transport: input?.transport ?? null, reason, input });
  }
  const keyHints = (file.bearerKeys || [])
    .filter((k) => k.enabled !== false)
    .map((k) => ({ name: k.name, servers: k.accessType === "servers" ? (k.allowedServers || []) : ("all" as const) }));
  return { servers, keyHints };
}

export function applyImport(plan: ImportPlan): { applied: string[] } {
  const applied: string[] = [];
  for (const item of plan.servers) {
    if (item.action === "skip" || !item.input) continue;
    upsertServer(item.input);
    applied.push(item.name);
  }
  return { applied };
}
