import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { getSettings, saveSettings, settingsSchema } from "@/server/settings";
import { hashPassword } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { dashboardPasswordHash, ...rest } = getSettings();
  return ok({ ...rest, passwordSet: !!dashboardPasswordHash || !!process.env.DASHBOARD_PASSWORD });
}

export async function PATCH(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson<Record<string, unknown>>(req);
  const patch: Record<string, unknown> = { ...body };
  if (typeof body.newPassword === "string") {
    patch.dashboardPasswordHash = body.newPassword ? hashPassword(body.newPassword) : null;
    delete patch.newPassword;
  }
  delete patch.passwordSet;
  const parsed = settingsSchema.partial().safeParse(patch);
  if (!parsed.success) return bad(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { dashboardPasswordHash, ...rest } = saveSettings(parsed.data);
  return ok({ ...rest, passwordSet: !!dashboardPasswordHash });
}
