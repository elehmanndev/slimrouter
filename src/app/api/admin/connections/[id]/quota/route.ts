import { requireAdmin, ok, bad } from "@/server/admin";
import { getConnection } from "@/server/connections";
import { fetchQuota } from "@/server/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const c = getConnection(id);
  if (!c) return bad("Not found", 404);
  const snap = await fetchQuota(c, true);
  return ok(snap || { connectionId: id, windows: [], error: "This provider does not report quota" });
}
