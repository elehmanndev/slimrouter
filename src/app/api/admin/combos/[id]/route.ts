import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { deleteCombo, listCombos, upsertCombo } from "@/server/combos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const current = listCombos().find((c) => c.id === id);
  if (!current) return bad("Not found", 404);
  const body = await readJson<{ name?: string; models?: string[]; strategy?: "fallback" | "round-robin" }>(req);
  return ok(upsertCombo({ id, name: body.name?.trim() || current.name, models: body.models?.length ? body.models : current.models, strategy: body.strategy || current.strategy }));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  deleteCombo(id);
  return ok({ ok: true });
}
