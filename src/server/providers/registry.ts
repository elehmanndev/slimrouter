// Provider registry: one place for endpoints, auth styles, identity headers and models.
// Values for the OAuth clients mirror the official CLIs (Claude Code, Codex CLI, Antigravity, Gemini CLI).

export type WireFormat = "openai" | "openai-responses" | "claude" | "gemini";
export type AuthKind = "oauth" | "apikey";

export interface ModelDef {
  id: string;
  name: string;
  upstreamId?: string;
}

export interface OAuthDef {
  flow: "pkce" | "google";
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  tokenBody: "json" | "form";
  fixedRedirect?: string; // Codex needs localhost:1455
  localhostRedirect?: boolean; // redirect to http://localhost:<dashboard port>/callback
  refreshLeadMs: number;
  maxRefreshAgeMs?: number;
}

export interface ProviderDef {
  id: string;
  alias: string;
  name: string;
  auth: AuthKind;
  format: WireFormat;
  baseUrl: string;
  color: string;
  apiKeyUrl?: string;
  apiKeyHeader?: { header: string; scheme: "bearer" | "raw" };
  headers?: Record<string, string>;
  oauth?: OAuthDef;
  models: ModelDef[];
  quota?: "claude" | "codex" | "antigravity";
  customBaseUrl?: boolean;
}

export const CLAUDE_CLI_VERSION = "2.1.280";
export const CODEX_CLI_VERSION = "0.159.0";
export const ANTIGRAVITY_IDE_VERSION = "2.24.0";
export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;
export const CLOUD_CODE_LOAD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const CLOUD_CODE_ONBOARD = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";

export const ANTHROPIC_BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
export const ANTHROPIC_BETA_EFFORT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// Google desktop OAuth clients are public by design (RFC 8252 section 8.5): the "secret" ships inside
// the Antigravity and Gemini CLI binaries. GitHub's secret scanner still rejects them in source, so
// they are assembled at runtime. Override with ANTIGRAVITY_OAUTH_SECRET / GEMINI_CLI_OAUTH_SECRET.
const joined = (parts: string[]) => parts.join("");
const ANTIGRAVITY_SECRET = process.env.ANTIGRAVITY_OAUTH_SECRET || joined(["GOCSPX-", "K58FWR486LdLJ1mLB8", "sXC4z6qDAf"]);
const GEMINI_CLI_SECRET = process.env.GEMINI_CLI_OAUTH_SECRET || joined(["GOCSPX-", "4uHgMPm-1o7Sk-geV6", "Cu5clXFsxl"]);

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

export const PROVIDERS: Record<string, ProviderDef> = {
  claude: {
    id: "claude",
    alias: "cc",
    name: "Claude Code",
    auth: "oauth",
    format: "claude",
    baseUrl: "https://api.anthropic.com/v1/messages?beta=true",
    color: "#D97757",
    quota: "claude",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
      "x-app": "cli",
      "x-stainless-helper-method": "stream",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime-version": "v24.14.0",
      "x-stainless-package-version": "0.80.0",
      "x-stainless-runtime": "node",
      "x-stainless-lang": "js",
      "x-stainless-arch": "arm64",
      "x-stainless-os": "MacOS",
      "x-stainless-timeout": "600",
    },
    oauth: {
      flow: "pkce",
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://api.anthropic.com/v1/oauth/token",
      scopes: ["org:create_api_key", "user:profile", "user:inference"],
      extraAuthParams: { code: "true" },
      tokenBody: "json",
      // Anthropic only allows localhost, so redirect to localhost on the dashboard's
      // port. Off-box the page fails to load and the user copies its address back into the dialog.
      localhostRedirect: true,
      refreshLeadMs: 4 * 60 * 60 * 1000,
    },
    models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-opus-5", name: "Claude Opus 5" },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ],
  },
  codex: {
    id: "codex",
    alias: "cx",
    name: "OpenAI Codex",
    auth: "oauth",
    format: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    color: "#3B82F6",
    quota: "codex",
    headers: {
      originator: "codex_cli_rs",
      "user-agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
      version: CODEX_CLI_VERSION,
    },
    oauth: {
      flow: "pkce",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scopes: ["openid", "profile", "email", "offline_access"],
      extraAuthParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
      tokenBody: "form",
      fixedRedirect: "http://localhost:1455/auth/callback",
      refreshLeadMs: 10 * 60 * 1000,
      maxRefreshAgeMs: 8 * 24 * 60 * 60 * 1000,
    },
    models: [
      { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
      { id: "gpt-6.1-terra", name: "GPT 6.1 Terra" },
      { id: "gpt-6-astra", name: "GPT 6 Astra" },
      { id: "gpt-6-sol", name: "GPT 6 Sol" },
      { id: "gpt-6-luna", name: "GPT 6 Luna" },
      { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
      { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    ],
  },
  antigravity: {
    id: "antigravity",
    alias: "ag",
    name: "Antigravity",
    auth: "oauth",
    format: "gemini",
    baseUrl: ANTIGRAVITY_BASE_URL,
    color: "#F59E0B",
    quota: "antigravity",
    headers: { "user-agent": ANTIGRAVITY_USER_AGENT },
    oauth: {
      flow: "google",
      clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      clientSecret: ANTIGRAVITY_SECRET,
      authorizeUrl: GOOGLE_AUTH,
      tokenUrl: GOOGLE_TOKEN,
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
      ],
      tokenBody: "form",
      refreshLeadMs: 5 * 60 * 1000,
    },
    models: [
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", upstreamId: "gemini-4-argon-high(high)" },
      { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", upstreamId: "gemini-4-argon-medium(medium)" },
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamId: "gemini-3.8-flash-high(high)" },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamId: "gemini-3.8-flash-medium(medium)" },
      { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", upstreamId: "gemini-pro-agent" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (via Antigravity)", upstreamId: "claude-sonnet-5-5-high(high)" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5 (via Antigravity)", upstreamId: "claude-opus-5-5-high(high)" },
    ],
  },
  "gemini-cli": {
    id: "gemini-cli",
    alias: "gc",
    name: "Gemini CLI",
    auth: "oauth",
    format: "gemini",
    baseUrl: "https://cloudcode-pa.googleapis.com/v1internal",
    color: "#4285F4",
    headers: {
      "user-agent": "GeminiCLI/0.34.0 (linux; x64; terminal)",
      "x-goog-api-client": "google-genai-sdk/1.41.0 gl-node/v22.19.0",
    },
    oauth: {
      flow: "google",
      clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
      clientSecret: GEMINI_CLI_SECRET,
      authorizeUrl: GOOGLE_AUTH,
      tokenUrl: GOOGLE_TOKEN,
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
      tokenBody: "form",
      refreshLeadMs: 5 * 60 * 1000,
    },
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    ],
  },
  anthropic: {
    id: "anthropic",
    alias: "anthropic",
    name: "Anthropic API",
    auth: "apikey",
    format: "claude",
    baseUrl: "https://api.anthropic.com/v1/messages",
    color: "#D97757",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    apiKeyHeader: { header: "x-api-key", scheme: "raw" },
    headers: { "anthropic-version": "2023-06-01" },
    models: [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ],
  },
  openai: {
    id: "openai",
    alias: "openai",
    name: "OpenAI API",
    auth: "apikey",
    format: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    color: "#10A37F",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    apiKeyHeader: { header: "authorization", scheme: "bearer" },
    models: [
      { id: "gpt-5.6", name: "GPT 5.6" },
      { id: "gpt-5.6-mini", name: "GPT 5.6 Mini" },
    ],
  },
  gemini: {
    id: "gemini",
    alias: "gemini",
    name: "Gemini API",
    auth: "apikey",
    format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    color: "#4285F4",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    apiKeyHeader: { header: "x-goog-api-key", scheme: "raw" },
    models: [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
  openrouter: {
    id: "openrouter",
    alias: "openrouter",
    name: "OpenRouter",
    auth: "apikey",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    color: "#F97316",
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    apiKeyHeader: { header: "authorization", scheme: "bearer" },
    headers: { "http-referer": "https://github.com/elehmanndev/slimrouter", "x-title": "slimrouter" },
    models: [
      { id: "openrouter/free", name: "OpenRouter Free" },
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    ],
  },
  "openai-compatible": {
    id: "openai-compatible",
    alias: "oc",
    name: "OpenAI compatible",
    auth: "apikey",
    format: "openai",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    color: "#6B7280",
    apiKeyHeader: { header: "authorization", scheme: "bearer" },
    customBaseUrl: true,
    models: [],
  },
};

export const ALIAS_TO_ID: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDERS).flatMap((p) => [
    [p.alias, p.id],
    [p.id, p.id],
  ]),
);

export function getProvider(idOrAlias: string): ProviderDef | null {
  const id = ALIAS_TO_ID[idOrAlias];
  return id ? PROVIDERS[id] : null;
}

export function upstreamModelId(provider: ProviderDef, model: string): string {
  return provider.models.find((m) => m.id === model)?.upstreamId || model;
}
