import { NextResponse } from "next/server";
import { isDashboardAuthed } from "./auth";

export function requireAdmin(req: Request): NextResponse | null {
  if (isDashboardAuthed(req.headers)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export const ok = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
