import { NextResponse } from "next/server";
import { isDashboardAuthed, passwordConfigured } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return NextResponse.json({ authed: isDashboardAuthed(req.headers), passwordConfigured: passwordConfigured() });
}
