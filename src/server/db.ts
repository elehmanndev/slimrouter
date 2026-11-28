import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  name TEXT,
  email TEXT,
  priority INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conn_provider ON connections(provider, is_active, priority);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  allowed_models TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS combos (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  models TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'fallback',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  requested_model TEXT,
  connection_id TEXT,
  api_key_id TEXT,
  endpoint TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_conn ON usage(connection_id, ts DESC);
CREATE TABLE IF NOT EXISTS quota_snapshots (
  connection_id TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  api_key_id TEXT,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_ts ON mcp_calls(ts DESC);
CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY,
  transport TEXT NOT NULL,
  config TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// Columns added after a table first shipped. ALTER only when missing, so old databases upgrade in place.
const MIGRATIONS: [table: string, column: string, ddl: string][] = [["api_keys", "allowed_mcp", "ALTER TABLE api_keys ADD COLUMN allowed_mcp TEXT"]];

function migrate(d: DatabaseSync) {
  for (const [table, column, ddl] of MIGRATIONS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) d.exec(ddl);
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "slimrouter.sqlite");
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const nowIso = () => new Date().toISOString();

export function kvGet<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown) {
  getDb()
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}
