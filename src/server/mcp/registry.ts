import { z } from "zod";
import { getDb, nowIso } from "../db";

/**
 * MCP servers slimrouter distributes. A server is either a remote Streamable HTTP endpoint or a
 * local stdio command. Secrets (env values, headers) live in this table, never in responses:
 * publicServer() masks them.
 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const toolsSchema = z.record(z.string(), z.object({ enabled: z.boolean() })).default({});

export const httpConfigSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    tools: toolsSchema,
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
  })
  .strict();

export const stdioConfigSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    tools: toolsSchema,
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
  })
  .strict();

export type HttpConfig = z.infer<typeof httpConfigSchema>;
export type StdioConfig = z.infer<typeof stdioConfigSchema>;

export type McpServer =
  | { name: string; transport: "http"; config: HttpConfig; description: string | null; enabled: boolean; createdAt: string; updatedAt: string }
  | { name: string; transport: "stdio"; config: StdioConfig; description: string | null; enabled: boolean; createdAt: string; updatedAt: string };

interface Row {
  name: string;
  transport: string;
  config: string;
  description: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToServer(r: Row): McpServer {
  const base = { name: r.name, description: r.description, enabled: r.enabled === 1, createdAt: r.created_at, updatedAt: r.updated_at };
  const raw = JSON.parse(r.config);
  return r.transport === "stdio" ? { ...base, transport: "stdio", config: stdioConfigSchema.parse(raw) } : { ...base, transport: "http", config: httpConfigSchema.parse(raw) };
}

export function listServers(opts: { enabledOnly?: boolean } = {}): McpServer[] {
  const rows = getDb().prepare(`SELECT * FROM mcp_servers ${opts.enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY name`).all() as unknown as Row[];
  return rows.map(rowToServer);
}

export function getServer(name: string): McpServer | null {
  const r = getDb().prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as unknown as Row | undefined;
  return r ? rowToServer(r) : null;
}

export const serverInputSchema = z.discriminatedUnion("transport", [
  z.object({ name: z.string().regex(NAME_RE), transport: z.literal("http"), config: httpConfigSchema, description: z.string().max(500).nullable().optional(), enabled: z.boolean().optional() }).strict(),
  z.object({ name: z.string().regex(NAME_RE), transport: z.literal("stdio"), config: stdioConfigSchema, description: z.string().max(500).nullable().optional(), enabled: z.boolean().optional() }).strict(),
]);
export type ServerInput = z.input<typeof serverInputSchema>;

export function upsertServer(input: ServerInput): McpServer {
  const s = serverInputSchema.parse(input);
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (name, transport, config, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET transport = excluded.transport, config = excluded.config, description = excluded.description, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .run(s.name, s.transport, JSON.stringify(s.config), s.description ?? null, s.enabled === false ? 0 : 1, ts, ts);
  return getServer(s.name)!;
}

export function setServerEnabled(name: string, enabled: boolean) {
  getDb().prepare("UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE name = ?").run(enabled ? 1 : 0, nowIso(), name);
}

export function setToolEnabled(name: string, tool: string, enabled: boolean): McpServer | null {
  const s = getServer(name);
  if (!s) return null;
  const tools = { ...s.config.tools, [tool]: { enabled } };
  getDb().prepare("UPDATE mcp_servers SET config = ?, updated_at = ? WHERE name = ?").run(JSON.stringify({ ...s.config, tools }), nowIso(), name);
  return getServer(name);
}

export function deleteServer(name: string) {
  getDb().prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
}

const mask = (o: Record<string, string>) => Object.fromEntries(Object.keys(o).map((k) => [k, "••••"]));

/** Server as the dashboard sees it: env values and header values hidden. */
export function publicServer(s: McpServer) {
  if (s.transport === "http") return { ...s, config: { ...s.config, headers: mask(s.config.headers) } };
  return { ...s, config: { ...s.config, env: mask(s.config.env) } };
}

/**
 * Apply an edit from the dashboard. Masked values ("••••") keep the stored secret, so the UI never
 * needs to see or resend it.
 */
export function mergeSecrets(current: McpServer | null, next: ServerInput): ServerInput {
  if (!current || current.transport !== next.transport) return next;
  const keep = (incoming: Record<string, string> | undefined, stored: Record<string, string>) =>
    Object.fromEntries(Object.entries(incoming || {}).map(([k, v]) => [k, v === "••••" && k in stored ? stored[k] : v]));
  if (next.transport === "http" && current.transport === "http") return { ...next, config: { ...next.config, headers: keep(next.config.headers, current.config.headers) } };
  if (next.transport === "stdio" && current.transport === "stdio") return { ...next, config: { ...next.config, env: keep(next.config.env, current.config.env) } };
  return next;
}
