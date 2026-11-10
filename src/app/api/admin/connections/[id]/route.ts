import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { deleteConnection, getConnection, publicConnection, updateConnection } from "@/server/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson<{ name?: string; priority?: number; isActive?: boolean; apiKey?: string; baseUrl?: string; clearLocks?: boolean }>(req);
  const patch: Parameters<typeof updateConnection>[1] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.priority === "number") patch.priority = body.priority;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  const data: Record<string, unknown> = {};
  if (typeof body.apiKey === "string" && body.apiKey) data.apiKey = body.apiKey;
  if (typeof body.baseUrl === "string") data.baseUrl = body.baseUrl;
  if (body.clearLocks) Object.assign(data, { lockedUntil: null, modelLocks: {}, backoffLevel: 0, lastError: null });
  if (Object.keys(data).length) patch.data = data;
  const c = updateConnection(id, patch);
  if (!c) return bad("Not found", 404);
  return ok(publicConnection(c));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!getConnection(id)) return bad("Not found", 404);
  deleteConnection(id);
  return ok({ ok: true });
}
