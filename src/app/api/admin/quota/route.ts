import { requireAdmin, ok } from "@/server/admin";
import { listConnections, publicConnection } from "@/server/connections";
import { fetchQuota } from "@/server/quota";
import { getProvider } from "@/server/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All quota snapshots; refreshes stale ones (cached per settings.quotaRefreshSec). */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const force = new URL(req.url).searchParams.get("force") === "1";
  const conns = listConnections().filter((c) => getProvider(c.provider)?.quota && c.authType === "oauth");
  const results = await Promise.all(conns.map(async (c) => ({ connection: publicConnection(c), quota: await fetchQuota(c, force) })));
  return ok(results);
}
