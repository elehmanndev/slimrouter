import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { deleteApiKey, updateApiKey } from "@/server/apikeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson<{ name?: string; isActive?: boolean; allowedModels?: string[] | null; allowedMcp?: unknown }>(req);
  const m = body.allowedMcp;
  if (m !== undefined && m !== null && !(Array.isArray(m) && m.every((s) => typeof s === "string"))) return bad("allowedMcp must be a list of server names, [*] for all, or null");
  const k = updateApiKey(id, { ...body, allowedMcp: m === undefined ? undefined : Array.isArray(m) && m.length ? (m as string[]) : null });
  return k ? ok(k) : bad("Not found", 404);
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  deleteApiKey(id);
  return ok({ ok: true });
}
