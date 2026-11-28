import { metadata } from "@/server/mcp/oauth-server";
import { publicOrigin } from "@/server/mcp/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => Response.json(metadata(publicOrigin(req)), { headers: { "access-control-allow-origin": "*" } });
