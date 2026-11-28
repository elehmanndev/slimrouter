import { getDb, nowIso } from "../db";

/** Per-call MCP log: which key used which tool, how long it took, whether it failed. No arguments or results are stored. */
export function recordMcpCall(r: { server: string; tool: string; apiKeyId: string | null; ok: boolean; durationMs: number; error: string | null }) {
  try {
    getDb()
      .prepare("INSERT INTO mcp_calls (ts, server, tool, api_key_id, ok, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(nowIso(), r.server, r.tool, r.apiKeyId, r.ok ? 1 : 0, r.durationMs, r.error ? r.error.slice(0, 300) : null);
  } catch {
    /* logging never breaks a call */
  }
}

export function mcpCallStats(sinceIso: string) {
  return getDb()
    .prepare("SELECT server, COUNT(*) AS calls, SUM(ok = 0) AS errors, AVG(duration_ms) AS avg_ms, MAX(ts) AS last_at FROM mcp_calls WHERE ts >= ? GROUP BY server")
    .all(sinceIso) as unknown as { server: string; calls: number; errors: number; avg_ms: number; last_at: string }[];
}

export function pruneMcpCalls(days = 30) {
  getDb().prepare("DELETE FROM mcp_calls WHERE ts < ?").run(new Date(Date.now() - days * 864e5).toISOString());
}
