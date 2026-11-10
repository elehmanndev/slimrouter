import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { completeAndRecord as completeOAuth } from "@/server/oauth";
import { publicConnection } from "@/server/connections";
import { fetchQuota } from "@/server/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { code, state } = await readJson<{ code?: string; state?: string }>(req);
  if (!code) return bad("Authorization code is required");
  try {
    const c = await completeOAuth({ code, state });
    void fetchQuota(c, true);
    return ok(publicConnection(c), 201);
  } catch (e) {
    return bad((e as Error).message);
  }
}
