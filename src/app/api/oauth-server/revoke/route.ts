import { revoke } from "@/server/mcp/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  revoke(new URLSearchParams(await req.text()));
  return new Response(null, { status: 200, headers: { "access-control-allow-origin": "*" } });
}
