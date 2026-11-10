import type { Usage } from "./translate/types";

export interface Price {
  input: number;
  output: number;
  cached: number;
  cacheCreation?: number;
}

// USD per 1M tokens. Subscription providers are billed at list price for an "equivalent spend" figure.
export const MODEL_PRICING: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cached: 0.2, cacheCreation: 5 },
  "claude-opus-5": { input: 5, output: 25, cached: 0.5, cacheCreation: 6.25 },
  "claude-fable-5-1": { input: 10, output: 50, cached: 1, cacheCreation: 12.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cached: 0.2, cacheCreation: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cached: 0.2, cacheCreation: 2.5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cached: 0.1, cacheCreation: 1.25 },
  "gpt-6.1-sol": { input: 2, output: 10, cached: 0.1 },
  "gpt-6.1-terra": { input: 1, output: 5, cached: 0.05 },
  "gpt-6-astra": { input: 10, output: 50, cached: 1 },
  "gpt-6-sol": { input: 2, output: 10, cached: 0.2 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cached: 0.01 },
  "gpt-5.6-sol": { input: 5, output: 30, cached: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cached: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cached: 0.1 },
  "gpt-5.6": { input: 2.5, output: 15, cached: 0.25 },
  "gpt-5.6-mini": { input: 0.5, output: 3, cached: 0.05 },
  "gemini-4-argon": { input: 2, output: 12, cached: 0.2 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5, cached: 0.15 },
  "gemini-3.5-flash": { input: 0.5, output: 3, cached: 0.03 },
  "gemini-3.1-pro": { input: 2, output: 12, cached: 0.2 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cached: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.03 },
};

const PATTERNS: [RegExp, Price][] = [
  [/^claude-opus/, MODEL_PRICING["claude-opus-5-5"]],
  [/^claude-sonnet/, MODEL_PRICING["claude-sonnet-5-5"]],
  [/^claude-haiku/, MODEL_PRICING["claude-haiku-4-5-20251001"]],
  [/^gpt-6\.1/, MODEL_PRICING["gpt-6.1-sol"]],
  [/^gpt-6/, MODEL_PRICING["gpt-6-sol"]],
  [/^gpt-5\.6/, MODEL_PRICING["gpt-5.6"]],
  [/argon/, MODEL_PRICING["gemini-4-argon"]],
  [/^gemini-3\.8/, MODEL_PRICING["gemini-3.8-flash"]],
  [/^gemini-3\.[0-7]-flash/, MODEL_PRICING["gemini-3.5-flash"]],
  [/^gemini-3\.\d-pro/, MODEL_PRICING["gemini-3.1-pro"]],
  [/^gemini-2\.5-pro/, MODEL_PRICING["gemini-2.5-pro"]],
  [/^gemini-2\.5/, MODEL_PRICING["gemini-2.5-flash"]],
];

export function priceFor(model: string): Price | null {
  const base = model.includes("/") ? model.split("/").pop()! : model;
  const clean = base.replace(/\([^()]+\)$/, "").replace(/-(high|medium|low)$/, "");
  if (MODEL_PRICING[clean]) return MODEL_PRICING[clean];
  if (MODEL_PRICING[base]) return MODEL_PRICING[base];
  for (const [re, p] of PATTERNS) if (re.test(clean)) return p;
  return null;
}

export function costOf(model: string, u: Usage | null | undefined): number {
  const p = priceFor(model);
  if (!p || !u) return 0;
  const cached = u.cached_tokens || 0;
  const creation = u.cache_creation_tokens || 0;
  const fresh = Math.max(0, u.prompt_tokens - cached - creation);
  return (fresh * p.input + cached * p.cached + creation * (p.cacheCreation ?? p.input) + u.completion_tokens * p.output) / 1_000_000;
}
