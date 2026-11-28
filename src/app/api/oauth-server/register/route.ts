import { OAuthError, registerClient } from "@/server/mcp/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata", error_description: "JSON body required" }, { status: 400, headers: cors });
  }
  try {
    const c = registerClient(body);
    return Response.json({ ...c, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { status: 201, headers: cors });
  } catch (e) {
    const err = e instanceof OAuthError ? e : new OAuthError("invalid_client_metadata", (e as Error).message);
    return Response.json({ error: err.code, error_description: err.message }, { status: err.status, headers: cors });
  }
}
export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
