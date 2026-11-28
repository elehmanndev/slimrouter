import { resourceMetadata } from "@/server/mcp/oauth-server";
import { publicOrigin } from "@/server/mcp/origin";
import { NAME_RE } from "@/server/mcp/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /.well-known/oauth-protected-resource/mcp[/<server>]
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const origin = publicOrigin(req);
  const ok = path[0] === "mcp" && (path.length === 1 || (path.length === 2 && NAME_RE.test(path[1])));
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(resourceMetadata(origin, `${origin}/${path.join("/")}`), { headers: { "access-control-allow-origin": "*" } });
}
