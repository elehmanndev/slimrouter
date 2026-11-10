import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";
import { getSettings, saveSettings } from "./settings";

const COOKIE = "slim_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

let secret: string | null = null;
function getSecret(): string {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) return (secret = process.env.SESSION_SECRET);
  mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "session-secret");
  if (existsSync(file)) return (secret = readFileSync(file, "utf8").trim());
  const s = randomBytes(32).toString("hex");
  writeFileSync(file, s, { mode: 0o600 });
  return (secret = s);
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Dashboard password: settings hash, else DASHBOARD_PASSWORD env. Empty env disables login (LAN use). */
export function passwordConfigured(): boolean {
  return !!getSettings().dashboardPasswordHash || !!process.env.DASHBOARD_PASSWORD;
}

export function checkPassword(pw: string): boolean {
  const stored = getSettings().dashboardPasswordHash;
  if (stored) return verifyPassword(pw, stored);
  const env = process.env.DASHBOARD_PASSWORD;
  if (env) {
    const ok = env.length === pw.length && timingSafeEqual(Buffer.from(env), Buffer.from(pw));
    if (ok) saveSettings({ dashboardPasswordHash: hashPassword(pw) });
    return ok;
  }
  return true;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function issueSession(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function validSession(token: string | undefined | null): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number };
    return exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function cookieFrom(headers: Headers): string | null {
  const raw = headers.get("cookie") || "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(raw);
  return m ? m[1] : null;
}

export function isDashboardAuthed(headers: Headers): boolean {
  if (!passwordConfigured()) return true;
  return validSession(cookieFrom(headers));
}
