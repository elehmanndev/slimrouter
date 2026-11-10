import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { createApiKey, listApiKeys } from "@/server/apikeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok(listApiKeys());
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { name, allowedModels } = await readJson<{ name?: string; allowedModels?: string[] | null }>(req);
  if (!name?.trim()) return bad("Name is required");
  return ok(createApiKey(name.trim(), Array.isArray(allowedModels) && allowedModels.length ? allowedModels : null), 201);
}
