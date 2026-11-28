import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { deleteServer, getServer, mergeSecrets, publicServer, serverInputSchema, setServerEnabled, upsertServer } from "@/server/mcp/registry";
import { closeUpstream, getUpstream, upstreamStatus, upstreamStderr } from "@/server/mcp/upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { name } = await ctx.params;
  const s = getServer(name);
  if (!s) return bad("Not found", 404);
  return ok({ ...publicServer(s), status: upstreamStatus(name), stderr: upstreamStderr(name) });
}

/** Full edit (same body as create) or { enabled } / { action: "restart" | "connect" }. */
export async function PATCH(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { name } = await ctx.params;
  const current = getServer(name);
  if (!current) return bad("Not found", 404);
  const body = await readJson<Record<string, unknown>>(req);
  if (body.action === "restart" || body.action === "connect") {
    if (body.action === "restart") await closeUpstream(name);
    try {
      await getUpstream(name);
    } catch (e) {
      return ok({ ...publicServer(getServer(name)!), status: upstreamStatus(name), error: (e as Error).message });
    }
    return ok({ ...publicServer(getServer(name)!), status: upstreamStatus(name) });
  }
  if (Object.keys(body).length === 1 && typeof body.enabled === "boolean") {
    setServerEnabled(name, body.enabled);
    if (!body.enabled) await closeUpstream(name);
    return ok(publicServer(getServer(name)!));
  }
  const parsed = serverInputSchema.safeParse({ ...body, name });
  if (!parsed.success) return bad(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const saved = upsertServer(mergeSecrets(current, parsed.data));
  await closeUpstream(name);
  return ok(publicServer(saved));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { name } = await ctx.params;
  await closeUpstream(name);
  deleteServer(name);
  return ok({ ok: true });
}
