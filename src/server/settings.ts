import { z } from "zod";
import { getDb } from "./db";

export const strategySchema = z.enum(["fill-first", "round-robin"]);

export const providerStrategySchema = z.object({
  strategy: strategySchema.default("fill-first"),
  // Consecutive requests served by one account before rotating (round-robin only).
  stickyLimit: z.number().int().min(1).max(1000).default(1),
  // Percent of a window that must remain before an account is taken out of rotation.
  // 0 disables the guard for that window.
  minRemainingSessionPercent: z.number().min(0).max(100).default(10),
  minRemainingWeeklyPercent: z.number().min(0).max(100).default(10),
});
export type ProviderStrategy = z.infer<typeof providerStrategySchema>;

export const settingsSchema = z.object({
  requireApiKey: z.boolean().default(true),
  dashboardPasswordHash: z.string().nullable().default(null),
  defaultStrategy: providerStrategySchema.default(() => providerStrategySchema.parse({})),
  providerStrategies: z.record(z.string(), providerStrategySchema).default({}),
  quotaRefreshSec: z.number().int().min(30).max(3600).default(300),
});
export type Settings = z.infer<typeof settingsSchema>;

export function getSettings(): Settings {
  const row = getDb().prepare("SELECT data FROM settings WHERE id = 1").get() as { data: string } | undefined;
  const parsed = settingsSchema.safeParse(row ? JSON.parse(row.data) : {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const merged = settingsSchema.parse({ ...getSettings(), ...patch });
  getDb()
    .prepare("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
    .run(JSON.stringify(merged));
  return merged;
}

export function strategyFor(provider: string): ProviderStrategy {
  const s = getSettings();
  return providerStrategySchema.parse({ ...s.defaultStrategy, ...(s.providerStrategies[provider] || {}) });
}
