import { requireAdmin, ok } from "@/server/admin";
import { recentRequests, usageSeries, usageSummary, usageTotals } from "@/server/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const range = new URL(req.url).searchParams.get("range") || "24h";
  return ok({
    range,
    totals: usageTotals(range),
    byProvider: usageSummary(range, "provider"),
    byModel: usageSummary(range, "model"),
    byConnection: usageSummary(range, "connection_id"),
    byKey: usageSummary(range, "api_key_id"),
    series: usageSeries(range),
    recent: recentRequests(40),
  });
}
