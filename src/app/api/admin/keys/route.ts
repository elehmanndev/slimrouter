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
  const { name, allowedModels, allowedMcp } = await readJson<{ name?: string; allowedModels?: string[] | null; allowedMcp?: unknown }>(req);
  if (allowedMcp !== undefined && allowedMcp !== null && !(Array.isArray(allowedMcp) && allowedMcp.every((s) => typeof s === "string"))) return bad("allowedMcp must be a list of server names, [*] for all, or null");
  if (!name?.trim()) return bad("Name is required");
  return ok(createApiKey(name.trim(), Array.isArray(allowedModels) && allowedModels.length ? allowedModels : null, Array.isArray(allowedMcp) && allowedMcp.length ? (allowedMcp as string[]) : null), 201);
}
