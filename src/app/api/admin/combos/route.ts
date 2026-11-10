import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { listCombos, upsertCombo } from "@/server/combos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok(listCombos());
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson<{ name?: string; models?: string[]; strategy?: "fallback" | "round-robin" }>(req);
  const name = body.name?.trim();
  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return bad("Name may contain letters, digits, dots, dashes and underscores");
  if (name.includes("/")) return bad("Combo names cannot contain a slash");
  if (!Array.isArray(body.models) || !body.models.length) return bad("Add at least one model");
  try {
    return ok(upsertCombo({ name, models: body.models, strategy: body.strategy }), 201);
  } catch (e) {
    return bad((e as Error).message);
  }
}
