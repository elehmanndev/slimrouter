import { completeAndRecord } from "@/server/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public callback target. The OAuth state is the only credential needed here: it was minted by an
 * authenticated dashboard session a few minutes ago and is single use. Providers that only allow a
 * localhost redirect land on a dead page in the browser; the dashboard page then forwards that URL here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error_description") || url.searchParams.get("error");
  const html = (ok: boolean, msg: string) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>slimrouter</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f7;color:#111"><div style="text-align:center;padding:2rem 2.5rem;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08)"><div style="font-size:2.5rem">${ok ? "✓" : "✕"}</div><p style="margin:.5rem 0 0">${msg.replace(/</g, "&lt;")}</p><p style="color:#777;font-size:.85rem">You can close this window.</p></div><script>try{window.opener&&window.opener.postMessage({type:"slimrouter-oauth",ok:${ok}},"*")}catch(e){}setTimeout(()=>window.close(),1500)</script>`,
      { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  if (error) return html(false, error);
  if (!code) return html(false, "No authorization code in the callback");
  try {
    const c = await completeAndRecord({ code, state });
    return html(true, `Connected ${c.name}`);
  } catch (e) {
    return html(false, (e as Error).message);
  }
}
