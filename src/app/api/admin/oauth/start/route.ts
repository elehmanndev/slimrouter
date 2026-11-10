import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { startOAuth } from "@/server/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { provider, origin } = await readJson<{ provider?: string; origin?: string }>(req);
  try {
    const o = origin || new URL(req.url).origin;
    return ok(startOAuth(provider || "", o));
  } catch (e) {
    return bad((e as Error).message);
  }
}
