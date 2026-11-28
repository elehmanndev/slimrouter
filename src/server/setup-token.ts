import { createConnection, listConnections, publicConnection, updateConnection } from "./connections";
import { claudeHeaderQuota } from "./quota";

/** What `claude setup-token` prints: an OAuth access token, never a refresh token (sk-ant-ort...). */
export const SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;
// claude setup-token grants one year (LONG_LIVED_OAUTH_TOKEN_TTL_SECONDS in Claude Code).
export const SETUP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function normalizeSetupToken(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("sk-ant-ort")) throw new Error("That is a refresh token. Paste the token claude setup-token prints (sk-ant-oat01-...)");
  if (t.startsWith("sk-ant-api")) throw new Error("That is an API key. Add it under Anthropic (API key), not Claude Code");
  if (!SETUP_TOKEN_RE.test(t)) throw new Error("Not a setup-token: expected sk-ant-oat01-... from claude setup-token");
  return t;
}

/**
 * Validate the token with one 1-token request (it also yields the first quota reading), then
 * store it. Pasting a token under a name that already holds a setup-token replaces that token,
 * keeping priority and history. The name is the only label: the profile endpoint needs the
 * user:profile scope, which a setup-token does not have.
 */
export async function addClaudeSetupToken(raw: string, name?: string) {
  const token = normalizeSetupToken(raw);
  const probe = await claudeHeaderQuota(token);
  if (probe.error && !probe.windows.length) {
    throw new Error(probe.error.includes("401") || probe.error.includes("403") ? "Anthropic rejected this token (revoked or mistyped)" : `Could not verify the token: ${probe.error}`);
  }
  const existing = listConnections({ provider: "claude" });
  const label = name?.trim() || `Claude setup token ${existing.length + 1}`;
  const data = {
    accessToken: token,
    setupToken: true,
    scope: "user:inference",
    expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_MS).toISOString(),
    lastRefreshAt: new Date().toISOString(),
    lastError: null,
    lastErrorAt: null,
    reauthRequired: false,
  };
  const same = name?.trim() ? existing.find((c) => c.data.setupToken && c.name === label) : undefined;
  if (same) return { connection: publicConnection(updateConnection(same.id, { data })!), replaced: true };
  return { connection: publicConnection(createConnection({ provider: "claude", authType: "oauth", name: label, email: null, data })), replaced: false };
}
