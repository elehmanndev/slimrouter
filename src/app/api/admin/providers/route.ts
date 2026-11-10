import { requireAdmin, ok } from "@/server/admin";
import { PROVIDERS } from "@/server/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok(
    Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      alias: p.alias,
      name: p.name,
      auth: p.auth,
      format: p.format,
      color: p.color,
      apiKeyUrl: p.apiKeyUrl || null,
      customBaseUrl: !!p.customBaseUrl,
      hasQuota: !!p.quota,
      models: p.models.map((m) => ({ id: m.id, name: m.name })),
    })),
  );
}
