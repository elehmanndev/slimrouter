import { requireAdmin, ok, bad } from "@/server/admin";
import { getClient, OAuthError, parseAuthorize } from "@/server/mcp/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validate an authorize query for the consent page before showing it. */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams.get("q") || "";
  try {
    const ar = parseAuthorize(new URLSearchParams(q));
    const client = getClient(ar.clientId)!;
    return ok({ clientName: client.name, redirectHost: new URL(ar.redirectUri).host });
  } catch (e) {
    return bad(e instanceof OAuthError ? e.message : (e as Error).message);
  }
}
