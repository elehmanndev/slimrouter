import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { approve, connectorSummary, denyRedirect, OAuthError, parseAuthorize, revokeConnector } from "@/server/mcp/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Connected OAuth clients (claude.ai, Claude Desktop) and the key each one is bound to. */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok(connectorSummary());
}

/**
 * Consent decision from the /oauth/authorize page. { query, decision: "approve" | "deny", apiKeyId? | newKeyName + allowedMcp }.
 * Returns the redirect URL for the browser.
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson<{ query?: unknown; decision?: unknown; apiKeyId?: unknown; newKeyName?: unknown; allowedMcp?: unknown }>(req);
  if (typeof body.query !== "string") return bad("query is required");
  try {
    const ar = parseAuthorize(new URLSearchParams(body.query));
    if (body.decision === "deny") return ok({ redirect: denyRedirect(ar) });
    if (body.decision !== "approve") return bad("decision must be approve or deny");
    if (typeof body.apiKeyId === "string") return ok({ redirect: approve(ar, { apiKeyId: body.apiKeyId }) });
    if (typeof body.newKeyName === "string" && Array.isArray(body.allowedMcp) && body.allowedMcp.every((s) => typeof s === "string") && body.allowedMcp.length) {
      return ok({ redirect: approve(ar, { newKeyName: body.newKeyName, allowedMcp: body.allowedMcp as string[] }) });
    }
    return bad("Pick a key or name a new one with its MCP access");
  } catch (e) {
    return bad(e instanceof OAuthError ? e.message : (e as Error).message);
  }
}

export async function DELETE(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const clientId = new URL(req.url).searchParams.get("clientId");
  if (!clientId) return bad("clientId is required");
  revokeConnector(clientId);
  return ok({ ok: true });
}
