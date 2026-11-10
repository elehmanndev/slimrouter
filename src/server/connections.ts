import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export interface ConnectionData {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string | null;
  lastRefreshAt?: string | null;
  apiKey?: string;
  baseUrl?: string;
  projectId?: string | null;
  accountId?: string | null; // Codex ChatGPT-Account-ID
  planType?: string | null;
  scope?: string;
  lastUsedAt?: string | null;
  consecutiveUseCount?: number;
  lockedUntil?: string | null; // account-wide cooldown
  modelLocks?: Record<string, string>; // model -> ISO expiry
  backoffLevel?: number;
  lastError?: string | null;
  lastErrorAt?: string | null;
  pausedByGuard?: { reason: string; until: string | null } | null;
}

export interface Connection {
  id: string;
  provider: string;
  authType: "oauth" | "apikey";
  name: string;
  email: string | null;
  priority: number;
  isActive: boolean;
  data: ConnectionData;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  provider: string;
  auth_type: string;
  name: string | null;
  email: string | null;
  priority: number;
  is_active: number;
  data: string;
  created_at: string;
  updated_at: string;
}

function rowToConn(r: Row): Connection {
  return {
    id: r.id,
    provider: r.provider,
    authType: r.auth_type as Connection["authType"],
    name: r.name || r.email || r.id.slice(0, 8),
    email: r.email,
    priority: r.priority,
    isActive: r.is_active === 1,
    data: JSON.parse(r.data) as ConnectionData,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listConnections(filter?: { provider?: string; activeOnly?: boolean }): Connection[] {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.provider) {
    where.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter?.activeOnly) where.push("is_active = 1");
  const sql = `SELECT * FROM connections ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY provider, priority ASC, created_at ASC`;
  return (db.prepare(sql).all(...params) as unknown as Row[]).map(rowToConn);
}

export function getConnection(id: string): Connection | null {
  const row = getDb().prepare("SELECT * FROM connections WHERE id = ?").get(id) as unknown as Row | undefined;
  return row ? rowToConn(row) : null;
}

export function createConnection(input: {
  provider: string;
  authType: Connection["authType"];
  name?: string | null;
  email?: string | null;
  data: ConnectionData;
}): Connection {
  const db = getDb();
  const max = db
    .prepare("SELECT COALESCE(MAX(priority), 0) AS m FROM connections WHERE provider = ?")
    .get(input.provider) as { m: number };
  const id = randomUUID();
  const ts = nowIso();
  db.prepare(
    "INSERT INTO connections (id, provider, auth_type, name, email, priority, is_active, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
  ).run(id, input.provider, input.authType, input.name ?? null, input.email ?? null, max.m + 1, JSON.stringify(input.data), ts, ts);
  return getConnection(id)!;
}

export function updateConnection(
  id: string,
  patch: { name?: string; priority?: number; isActive?: boolean; data?: Partial<ConnectionData> },
): Connection | null {
  const db = getDb();
  const current = getConnection(id);
  if (!current) return null;
  const data = { ...current.data, ...(patch.data || {}) };
  db.prepare(
    "UPDATE connections SET name = ?, priority = ?, is_active = ?, data = ?, updated_at = ? WHERE id = ?",
  ).run(
    patch.name ?? current.name,
    patch.priority ?? current.priority,
    (patch.isActive ?? current.isActive) ? 1 : 0,
    JSON.stringify(data),
    nowIso(),
    id,
  );
  return getConnection(id);
}

export function patchConnectionData(id: string, patch: Partial<ConnectionData>) {
  return updateConnection(id, { data: patch });
}

export function deleteConnection(id: string) {
  getDb().prepare("DELETE FROM connections WHERE id = ?").run(id);
  getDb().prepare("DELETE FROM quota_snapshots WHERE connection_id = ?").run(id);
}

export function reorderConnections(provider: string, orderedIds: string[]) {
  const db = getDb();
  const stmt = db.prepare("UPDATE connections SET priority = ?, updated_at = ? WHERE id = ? AND provider = ?");
  orderedIds.forEach((id, i) => stmt.run(i + 1, nowIso(), id, provider));
}

/** Strip secrets for API responses. */
export function publicConnection(c: Connection) {
  const { accessToken, refreshToken, idToken, apiKey, ...rest } = c.data;
  return {
    ...c,
    data: {
      ...rest,
      hasRefreshToken: !!refreshToken,
      hasAccessToken: !!accessToken || !!idToken,
      apiKeyPreview: apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : null,
    },
  };
}
