import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { getServer, setToolEnabled } from "@/server/mcp/registry";
import { getUpstream } from "@/server/mcp/upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/** Live tool list of a server, connecting if needed, with each tool's switch. */
export async function GET(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { name } = await ctx.params;
  const s = getServer(name);
  if (!s) return bad("Not found", 404);
  try {
    const live = await getUpstream(name);
    return ok(live.tools.map((t) => ({ name: t.name, description: t.description ?? null, enabled: s.config.tools[t.name]?.enabled !== false })));
  } catch (e) {
    return bad((e as Error).message, 502);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { name } = await ctx.params;
  const { tool, enabled } = await readJson<{ tool?: unknown; enabled?: unknown }>(req);
  if (typeof tool !== "string" || typeof enabled !== "boolean") return bad("tool (string) and enabled (boolean) are required");
  const s = setToolEnabled(name, tool, enabled);
  return s ? ok({ ok: true }) : bad("Not found", 404);
}
