import { requireAdmin, ok, bad } from "@/server/admin";
import { oauthStatus } from "@/server/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const state = new URL(req.url).searchParams.get("state");
  if (!state) return bad("state is required");
  return ok(oauthStatus(state));
}
