import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { getServer, listServers, mergeSecrets, publicServer, serverInputSchema, upsertServer } from "@/server/mcp/registry";
import { upstreamStatus } from "@/server/mcp/upstream";
import { mcpCallStats } from "@/server/mcp/log";
import { sessionCount } from "@/server/mcp/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const stats = new Map(mcpCallStats(new Date(Date.now() - 864e5).toISOString()).map((s) => [s.server, s]));
  return ok({
    sessions: sessionCount(),
    servers: listServers().map((s) => ({ ...publicServer(s), status: upstreamStatus(s.name), last24h: stats.get(s.name) ?? null })),
  });
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson(req);
  const parsed = serverInputSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (getServer(parsed.data.name)) return bad("A server with that name exists; edit it instead", 409);
  return ok(publicServer(upsertServer(mergeSecrets(null, parsed.data))), 201);
}
