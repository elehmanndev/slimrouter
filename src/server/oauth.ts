import { getProvider, type ProviderDef, CLOUD_CODE_LOAD, CLOUD_CODE_ONBOARD, ANTIGRAVITY_USER_AGENT } from "./providers/registry";
import { generatePkce, decodeJwtPayload } from "./pkce";
import { createConnection, patchConnectionData, type Connection, type ConnectionData } from "./connections";

interface PendingAuth {
  provider: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

// state -> pending auth; short lived, in memory
const pending = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 15 * 60 * 1000;

// state -> outcome, so the dashboard can poll instead of asking the user to paste anything.
const outcomes = new Map<string, { status: "done" | "error"; connectionId?: string; name?: string; message?: string; at: number }>();

function gc() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  for (const [k, v] of outcomes) if (now - v.at > PENDING_TTL_MS) outcomes.delete(k);
}

/** Dashboard polls this with the state it got from startOAuth. */
export function oauthStatus(state: string): { status: "pending" | "done" | "error" | "unknown"; connectionId?: string; name?: string; message?: string } {
  gc();
  const o = outcomes.get(state);
  if (o) return o;
  return pending.has(state) ? { status: "pending" } : { status: "unknown" };
}

/** Called by the callback page or a localhost catcher: completes the flow and records the outcome for pollers. */
export async function completeAndRecord(input: { code: string; state?: string | null }) {
  const stateHint = input.state || (input.code.includes("#") ? input.code.split("#")[1] : "");
  try {
    const c = await completeOAuth(input);
    if (stateHint) outcomes.set(stateHint, { status: "done", connectionId: c.id, name: c.name, at: Date.now() });
    return c;
  } catch (e) {
    if (stateHint) outcomes.set(stateHint, { status: "error", message: (e as Error).message, at: Date.now() });
    throw e;
  }
}

export function defaultRedirectUri(provider: ProviderDef, origin: string) {
  if (provider.oauth?.fixedRedirect) return provider.oauth.fixedRedirect;
  if (provider.oauth?.localhostRedirect) {
    const u = new URL(origin);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    // Anthropic's allowlist is localhost on any port with the exact path /callback (what 9router sends).
    return `http://localhost:${port}/callback`;
  }
  return `${origin}/oauth/callback`;
}

export function startOAuth(providerId: string, origin: string) {
  const provider = getProvider(providerId);
  if (!provider?.oauth) throw new Error(`Provider ${providerId} has no OAuth flow`);
  gc();
  const { codeVerifier, codeChallenge, state } = generatePkce();
  const redirectUri = defaultRedirectUri(provider, origin);
  const o = provider.oauth;
  const params = new URLSearchParams();
  if (o.flow === "pkce") {
    for (const [k, v] of Object.entries(o.extraAuthParams || {})) params.set(k, v);
    params.set("client_id", o.clientId);
    params.set("response_type", "code");
    params.set("redirect_uri", redirectUri);
    params.set("scope", o.scopes.join(" "));
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
    params.set("state", state);
  } else {
    params.set("client_id", o.clientId);
    params.set("response_type", "code");
    params.set("redirect_uri", redirectUri);
    params.set("scope", o.scopes.join(" "));
    params.set("state", state);
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  pending.set(state, { provider: provider.id, codeVerifier, redirectUri, createdAt: Date.now() });
  return { authorizeUrl: `${o.authorizeUrl}?${params.toString()}`, state, redirectUri, manualPaste: provider.id === "claude" };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

async function exchange(provider: ProviderDef, code: string, state: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
  const o = provider.oauth!;
  const payload: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: o.clientId,
    code,
    redirect_uri: redirectUri,
  };
  if (o.flow === "pkce") payload.code_verifier = verifier;
  if (o.clientSecret) payload.client_secret = o.clientSecret;
  if (provider.id === "claude") payload.state = state;
  const res = await fetch(o.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": o.tokenBody === "json" ? "application/json" : "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: o.tokenBody === "json" ? JSON.stringify(payload) : new URLSearchParams(payload),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as TokenResponse;
}

/**
 * Finish an OAuth flow. `code` may be the raw code or, for Claude, the pasted "CODE#STATE" string.
 */
export async function completeOAuth(input: { code: string; state?: string | null }): Promise<Connection> {
  gc();
  let code = input.code.trim();
  let state = input.state?.trim() || "";
  if (code.includes("#")) {
    const [c, s] = code.split("#");
    code = c;
    state = state || s || "";
  }
  if (!state && pending.size === 1) state = [...pending.keys()][0];
  const p = pending.get(state);
  if (!p) throw new Error("OAuth session not found or expired. Start the connection again.");
  const provider = getProvider(p.provider)!;
  const tokens = await exchange(provider, code, state, p.codeVerifier, p.redirectUri);
  pending.delete(state);

  const data: ConnectionData = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    scope: tokens.scope,
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
    lastRefreshAt: new Date().toISOString(),
  };
  let email: string | null = null;

  if (provider.id === "codex") {
    const claims = decodeJwtPayload(tokens.id_token) || decodeJwtPayload(tokens.access_token) || {};
    const auth = (claims["https://api.openai.com/auth"] as Record<string, string>) || {};
    const profile = (claims["https://api.openai.com/profile"] as Record<string, string>) || {};
    email = (claims.email as string) || profile.email || null;
    data.accountId = auth.chatgpt_account_id || null;
    data.planType = auth.chatgpt_plan_type || null;
  }
  if (provider.oauth!.flow === "google") {
    email = await googleEmail(tokens.access_token);
    data.projectId = await resolveProjectId(tokens.access_token, provider.id === "antigravity");
  }
  if (provider.id === "claude") {
    email = await claudeEmail(tokens.access_token);
  }

  const count = (await import("./connections")).listConnections({ provider: provider.id }).length;
  return createConnection({
    provider: provider.id,
    authType: "oauth",
    name: email || `${provider.name} ${count + 1}`,
    email,
    data,
  });
}

async function googleEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { email?: string };
    return j.email || null;
  } catch {
    return null;
  }
}

async function claudeEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { account?: { email_address?: string; email?: string } };
    return j.account?.email_address || j.account?.email || null;
  } catch {
    return null;
  }
}

const CLOUD_CODE_METADATA = { ideType: 9, platform: 3, pluginType: 2 };

/** Resolve the Cloud Code Assist project id; onboard the user when missing. */
export async function resolveProjectId(accessToken: string, antigravity: boolean): Promise<string | null> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": antigravity ? ANTIGRAVITY_USER_AGENT : "google-api-nodejs-client/9.15.1",
    ...(antigravity ? {} : { "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1" }),
  };
  try {
    const r = await fetch(CLOUD_CODE_LOAD, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: CLOUD_CODE_METADATA }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      cloudaicompanionProject?: string | { id?: string };
      allowedTiers?: { id?: string; isDefault?: boolean }[];
    };
    const pid = typeof data.cloudaicompanionProject === "string" ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
    if (pid) return pid;
    const tierId = data.allowedTiers?.find((t) => t.isDefault && t.id)?.id || "legacy-tier";
    for (let i = 0; i < 2; i++) {
      const o = await fetch(CLOUD_CODE_ONBOARD, {
        method: "POST",
        headers,
        body: JSON.stringify({ tierId, metadata: CLOUD_CODE_METADATA }),
      });
      if (!o.ok) return null;
      const j = (await o.json()) as { done?: boolean; response?: { cloudaicompanionProject?: string | { id?: string } } };
      if (j.done) {
        const p = j.response?.cloudaicompanionProject;
        return typeof p === "string" ? p : p?.id || null;
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
  } catch {
    return null;
  }
  return null;
}

const refreshInFlight = new Map<string, Promise<ConnectionData | null>>();

export function needsRefresh(provider: ProviderDef, c: Connection): boolean {
  if (c.authType !== "oauth" || !provider.oauth) return false;
  const exp = c.data.expiresAt ? Date.parse(c.data.expiresAt) : NaN;
  if (Number.isFinite(exp) && exp - Date.now() < provider.oauth.refreshLeadMs) return true;
  if (provider.oauth.maxRefreshAgeMs && c.data.refreshToken) {
    const last = c.data.lastRefreshAt ? Date.parse(c.data.lastRefreshAt) : NaN;
    if (!Number.isFinite(last) || Date.now() - last >= provider.oauth.maxRefreshAgeMs) return true;
  }
  return false;
}

/** Refresh the access token, persist, and return the new data. Deduped per connection. */
export async function refreshConnection(c: Connection): Promise<ConnectionData | null> {
  const provider = getProvider(c.provider);
  if (!provider?.oauth || !c.data.refreshToken) return null;
  const existing = refreshInFlight.get(c.id);
  if (existing) return existing;
  const task = (async () => {
    const o = provider.oauth!;
    const payload: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: c.data.refreshToken!,
      client_id: o.clientId,
    };
    if (o.clientSecret) payload.client_secret = o.clientSecret;
    if (provider.id === "codex") payload.scope = o.scopes.join(" ");
    const json = o.tokenBody === "json" || provider.id === "codex";
    const res = await fetch(o.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: json ? JSON.stringify(payload) : new URLSearchParams(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      const permanent = /invalid_grant|refresh_token_(expired|reused|invalidated)/i.test(text);
      patchConnectionData(c.id, {
        lastError: `Token refresh failed (${res.status})${permanent ? ": re-authorize this account" : ""}`,
        lastErrorAt: new Date().toISOString(),
      });
      return null;
    }
    const t = (await res.json()) as TokenResponse;
    const patch: Partial<ConnectionData> = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token || c.data.refreshToken,
      idToken: t.id_token || c.data.idToken,
      expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : c.data.expiresAt,
      lastRefreshAt: new Date().toISOString(),
      lastError: null,
    };
    const updated = patchConnectionData(c.id, patch);
    return updated?.data || null;
  })().finally(() => refreshInFlight.delete(c.id));
  refreshInFlight.set(c.id, task);
  return task;
}

/** Return a connection whose access token is fresh enough to use. */
export async function ensureFresh(c: Connection): Promise<Connection> {
  const provider = getProvider(c.provider);
  if (!provider || !needsRefresh(provider, c)) return c;
  const data = await refreshConnection(c);
  return data ? { ...c, data } : c;
}
