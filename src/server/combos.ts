import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export interface Combo {
  id: string;
  name: string;
  models: string[]; // "cc/claude-opus-5-5" style targets, or other combo names
  strategy: "fallback" | "round-robin";
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  models: string;
  strategy: string;
  created_at: string;
  updated_at: string;
}

const toCombo = (r: Row): Combo => ({ id: r.id, name: r.name, models: JSON.parse(r.models), strategy: r.strategy as Combo["strategy"], createdAt: r.created_at, updatedAt: r.updated_at });

export function listCombos(): Combo[] {
  return (getDb().prepare("SELECT * FROM combos ORDER BY name").all() as unknown as Row[]).map(toCombo);
}

export function getCombo(name: string): Combo | null {
  const r = getDb().prepare("SELECT * FROM combos WHERE name = ?").get(name) as unknown as Row | undefined;
  return r ? toCombo(r) : null;
}

export function upsertCombo(input: { id?: string; name: string; models: string[]; strategy?: Combo["strategy"] }): Combo {
  const ts = nowIso();
  if (input.id) {
    getDb().prepare("UPDATE combos SET name = ?, models = ?, strategy = ?, updated_at = ? WHERE id = ?").run(input.name, JSON.stringify(input.models), input.strategy || "fallback", ts, input.id);
    return toCombo(getDb().prepare("SELECT * FROM combos WHERE id = ?").get(input.id) as unknown as Row);
  }
  const id = randomUUID();
  getDb().prepare("INSERT INTO combos (id, name, models, strategy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.name, JSON.stringify(input.models), input.strategy || "fallback", ts, ts);
  return toCombo(getDb().prepare("SELECT * FROM combos WHERE id = ?").get(id) as unknown as Row);
}

export function deleteCombo(id: string) {
  getDb().prepare("DELETE FROM combos WHERE id = ?").run(id);
}

// In-memory rotation pointer per combo for round-robin combos.
const rotation = new Map<string, number>();

/** Expand a combo (recursively) into an ordered list of "alias/model" targets. */
export function expandCombo(name: string, seen = new Set<string>()): string[] {
  const combo = getCombo(name);
  if (!combo || seen.has(name)) return [];
  seen.add(name);
  let models = combo.models;
  if (combo.strategy === "round-robin" && models.length > 1) {
    const i = rotation.get(name) || 0;
    rotation.set(name, (i + 1) % models.length);
    models = [...models.slice(i), ...models.slice(0, i)];
  }
  return models.flatMap((m) => (m.includes("/") ? [m] : expandCombo(m, seen)));
}
