import { NextResponse } from "next/server";
import { checkPassword, issueSession, sessionCookie } from "@/server/auth";
import { readJson } from "@/server/admin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { password } = await readJson<{ password?: string }>(req);
  if (!checkPassword(password || "")) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  const secure = req.headers.get("x-forwarded-proto") === "https";
  const res = NextResponse.json({ ok: true });
  res.headers.append("set-cookie", sessionCookie(issueSession(), secure));
  res.headers.append("set-cookie", `slim_pw=1; Path=/; SameSite=Lax; Max-Age=${365 * 86400}`);
  return res;
}
