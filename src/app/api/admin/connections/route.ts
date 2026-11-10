import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { createConnection, listConnections, publicConnection } from "@/server/connections";
import { getProvider } from "@/server/providers/registry";
import { readSnapshot } from "@/server/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok(listConnections().map((c) => ({ ...publicConnection(c), quota: readSnapshot(c.id) })));
}

/** Add an API-key connection. OAuth connections go through /api/admin/oauth/*. */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson<{ provider?: string; apiKey?: string; name?: string; baseUrl?: string }>(req);
  const provider = getProvider(body.provider || "");
  if (!provider) return bad("Unknown provider");
  if (provider.auth !== "apikey") return bad("This provider uses OAuth");
  if (!body.apiKey?.trim()) return bad("API key is required");
  if (provider.customBaseUrl && !body.baseUrl?.trim()) return bad("Base URL is required");
  const count = listConnections({ provider: provider.id }).length;
  const c = createConnection({
    provider: provider.id,
    authType: "apikey",
    name: body.name?.trim() || `${provider.name} ${count + 1}`,
    data: { apiKey: body.apiKey.trim(), baseUrl: body.baseUrl?.trim() || undefined },
  });
  return ok(publicConnection(c), 201);
}
