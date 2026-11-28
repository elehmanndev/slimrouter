import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { applyImport, planMcphubImport } from "@/server/mcp/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Import an mcphub mcp_settings.json. { settings, pathMap?, skip?, apply? }: without apply: true it
 * only returns the plan (dry run). Secrets are never echoed back.
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson<{ settings?: unknown; pathMap?: unknown; skip?: unknown; apply?: unknown }>(req);
  if (body.apply !== undefined && typeof body.apply !== "boolean") return bad("apply must be a boolean");
  const pathMap = body.pathMap && typeof body.pathMap === "object" ? (body.pathMap as Record<string, string>) : {};
  const skip = Array.isArray(body.skip) ? body.skip.filter((s): s is string => typeof s === "string") : [];
  let plan;
  try {
    plan = planMcphubImport(body.settings, { pathMap, skip });
  } catch (e) {
    return bad(`Not an mcphub settings file: ${(e as Error).message.slice(0, 200)}`);
  }
  const summary = { servers: plan.servers.map((s) => ({ name: s.name, action: s.action, transport: s.transport, enabled: s.enabled, reason: s.reason })), keyHints: plan.keyHints };
  if (body.apply !== true) return ok({ dryRun: true, ...summary });
  return ok({ dryRun: false, ...applyImport(plan), ...summary });
}
