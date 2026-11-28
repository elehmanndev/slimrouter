import { OAuthError, exchange } from "@/server/mcp/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };

async function readForm(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(j).filter(([, v]) => typeof v === "string") as [string, string][]);
  }
  return new URLSearchParams(await req.text());
}

export async function POST(req: Request) {
  try {
    const tokens = exchange(await readForm(req));
    return Response.json(tokens, { headers: { ...cors, "cache-control": "no-store" } });
  } catch (e) {
    const err = e instanceof OAuthError ? e : new OAuthError("invalid_request", (e as Error).message);
    return Response.json({ error: err.code, error_description: err.message }, { status: err.status, headers: { ...cors, "cache-control": "no-store" } });
  }
}
export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
