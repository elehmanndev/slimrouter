import { requireAdmin, ok, bad } from "@/server/admin";
import { getConnection } from "@/server/connections";
import { getProvider } from "@/server/providers/registry";
import { ensureFresh } from "@/server/oauth";
import { buildUpstream } from "@/server/executors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Send a tiny request through the connection to confirm it works. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const c = getConnection(id);
  const provider = c && getProvider(c.provider);
  if (!c || !provider) return bad("Not found", 404);
  const model = provider.models[provider.models.length - 1]?.id || provider.models[0]?.id;
  if (!model) return ok({ ok: false, error: "No model to test with" });
  const started = Date.now();
  try {
    const fresh = await ensureFresh(c);
    const spec = buildUpstream(provider, fresh, { model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 16, stream: true }, null, new Headers());
    const res = await fetch(spec.url, { method: "POST", headers: spec.headers, body: JSON.stringify(spec.body) });
    const text = res.ok ? "" : (await res.text()).slice(0, 300);
    res.body?.cancel().catch(() => undefined);
    return ok({ ok: res.ok, status: res.status, model, ms: Date.now() - started, error: res.ok ? null : text });
  } catch (e) {
    return ok({ ok: false, status: 0, model, ms: Date.now() - started, error: (e as Error).message });
  }
}
