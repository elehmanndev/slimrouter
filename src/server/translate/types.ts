// Internal canonical shape: OpenAI Chat Completions. Everything pivots through it.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ContentText { type: "text"; text: string }
export interface ContentImage { type: "image_url"; image_url: { url: string; detail?: string } }
export type ContentPart = ContentText | ContentImage;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoning_effort?: string;
  stop?: string | string[];
  metadata?: Record<string, unknown>;
  // Original anthropic fields we may want to pass straight through on claude->claude.
  _raw?: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
}

export interface ChunkDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: { index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }[];
}

export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: { index: 0; delta: ChunkDelta; finish_reason: FinishReason | null }[];
  usage?: Usage;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export function chunk(id: string, model: string, delta: ChunkDelta, finish: FinishReason | null = null, usage?: Usage): ChatChunk {
  const c: ChatChunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) c.usage = usage;
  return c;
}

export function safeJson(s: string | undefined | null): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function textOf(content: string | ContentPart[] | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is ContentText => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function parseDataUri(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
  return m ? { mime: m[1], data: m[2] } : null;
}
