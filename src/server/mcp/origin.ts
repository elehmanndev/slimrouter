/**
 * Public origin of this gateway as clients see it. Behind Cloudflare and NPM the request's own
 * host is internal, so PUBLIC_URL wins; otherwise the forwarded headers, then the Host header.
 */
export function publicOrigin(req: Request): string {
  const env = process.env.PUBLIC_URL?.replace(/\/$/, "");
  if (env) return env;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host") || new URL(req.url).host;
  return `${proto}://${host}`;
}
