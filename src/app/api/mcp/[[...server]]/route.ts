import { extractBearer, verifyApiKey } from "@/server/apikeys";
import { handleMcpRequest } from "@/server/mcp/gateway";
import { NAME_RE } from "@/server/mcp/registry";
import { keyForAccessToken } from "@/server/mcp/oauth-server";
import { publicOrigin } from "@/server/mcp/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ server?: string[] }> };

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { server } = await ctx.params;
  if (server && (server.length !== 1 || !NAME_RE.test(server[0]))) return withCors(Response.json({ error: "Unknown MCP path" }, { status: 404 }));
  const bearer = extractBearer(req.headers, new URL(req.url));
  // Client keys (sk-slim-) for CLIs and agents; OAuth access tokens (sla_) for claude.ai and Claude Desktop.
  const key = verifyApiKey(bearer) ?? keyForAccessToken(bearer);
  if (!key) {
    const meta = `${publicOrigin(req)}/.well-known/oauth-protected-resource${server ? `/mcp/${server[0]}` : "/mcp"}`;
    return withCors(
      Response.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "Invalid or missing API key" }, id: null },
        { status: 401, headers: { "www-authenticate": `Bearer realm="slimrouter", resource_metadata="${meta}"` } },
      ),
    );
  }
  return withCors(await handleMcpRequest(req, key, server?.[0] ?? null));
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = () => new Response(null, { status: 204, headers: cors });
