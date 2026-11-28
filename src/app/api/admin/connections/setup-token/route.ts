import { requireAdmin, readJson, ok, bad } from "@/server/admin";
import { addClaudeSetupToken } from "@/server/setup-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add or replace a Claude account from a `claude setup-token` (sk-ant-oat01-...). */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson<{ token?: unknown; name?: unknown }>(req);
  if (typeof body.token !== "string" || (body.name !== undefined && typeof body.name !== "string")) return bad("token must be a string");
  try {
    const { connection, replaced } = await addClaudeSetupToken(body.token, body.name as string | undefined);
    return ok({ connection, replaced }, replaced ? 200 : 201);
  } catch (e) {
    return bad((e as Error).message);
  }
}
