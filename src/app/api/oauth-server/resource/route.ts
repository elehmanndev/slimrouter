import { resourceMetadata } from "@/server/mcp/oauth-server";
import { publicOrigin } from "@/server/mcp/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => {
  const origin = publicOrigin(req);
  return Response.json(resourceMetadata(origin, `${origin}/mcp`), { headers: { "access-control-allow-origin": "*" } });
};
