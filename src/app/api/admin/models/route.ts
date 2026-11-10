import { requireAdmin, ok } from "@/server/admin";
import { visibleModels } from "@/server/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return ok(visibleModels(null));
}
