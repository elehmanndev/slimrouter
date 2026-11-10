import { NextResponse } from "next/server";
import { clearCookie } from "@/server/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.append("set-cookie", clearCookie);
  return res;
}
