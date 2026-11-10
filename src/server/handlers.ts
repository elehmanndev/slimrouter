import { NextResponse } from "next/server";
import { execute, GatewayError } from "./gateway";
import { getSettings } from "./settings";
import { extractBearer, verifyApiKey, type ApiKey } from "./apikeys";
import { claudeToChat, encodeClaudeEvents, newClaudeEncodeState, type ClaudeRequest } from "./translate/claude";
import { encodeResponsesEvents, newResponsesEncodeState, responsesObjectFromChunks, responsesToChat, type ResponsesRequest } from "./translate/responses";
import { completionFromChunks, usageForClient } from "./translate/openai";
import { sseLine } from "./sse";
import type { ChatChunk, ChatRequest } from "./translate/types";
import { listCombos } from "./combos";
import { PROVIDERS } from "./providers/registry";
import { listConnections } from "./connections";

type ClientFormat = "openai" | "claude" | "responses";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

export function corsPreflight() {
  return new NextResponse(null, { status: 204, headers: cors });
}

function isLoopback(req: Request): boolean {
  const host = (req.headers.get("host") || "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function authenticate(req: Request): { ok: true; key: ApiKey | null } | { ok: false } {
  const url = new URL(req.url);
  const token = extractBearer(req.headers, url);
  const key = verifyApiKey(token);
  if (key) return { ok: true, key };
  if (!getSettings().requireApiKey && isLoopback(req)) return { ok: true, key: null };
  return { ok: false };
}

function errorBody(format: ClientFormat, status: number, message: string, retryAfter: string | null) {
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
  const body = format === "claude" ? { type: "error", error: { type, message } } : { error: { message, type, code: status === 429 ? "rate_limit_exceeded" : null } };
  const headers: Record<string, string> = { ...cors, "content-type": "application/json" };
  if (retryAfter) headers["retry-after"] = String(Math.max(1, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)));
  return NextResponse.json(body, { status, headers });
}

function decloak(c: ChatChunk, map?: Map<string, string>): ChatChunk {
  if (!map?.size) return c;
  const d = c.choices[0]?.delta;
  if (!d?.tool_calls) return c;
  for (const tc of d.tool_calls) {
    const n = tc.function?.name;
    if (n && map.has(n)) tc.function!.name = map.get(n)!;
    else if (n && n.endsWith("_ide")) tc.function!.name = n.slice(0, -4);
  }
  return c;
}

export async function handleChat(req: Request, format: ClientFormat) {
  const auth = authenticate(req);
  if (!auth.ok) return errorBody(format, 401, "Invalid or missing API key. Create one in the dashboard.", null);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorBody(format, 400, "Invalid JSON body", null);
  }
  const requestedModel = String(body.model || "");
  if (!requestedModel) return errorBody(format, 400, "model is required", null);
  if (auth.key?.allowedModels?.length && !auth.key.allowedModels.includes(requestedModel.replace(/\[1m\]$/, ""))) return errorBody(format, 403, `This key may not use model ${requestedModel}`, null);

  let chatReq: ChatRequest;
  let rawClaude: ClaudeRequest | null = null;
  if (format === "claude") {
    rawClaude = body as unknown as ClaudeRequest;
    chatReq = claudeToChat(rawClaude);
  } else if (format === "responses") chatReq = responsesToChat(body as unknown as ResponsesRequest);
  else chatReq = { ...(body as unknown as ChatRequest), messages: (body.messages as ChatRequest["messages"]) || [] };
  const stream = body.stream === true;
  const endpoint = format === "claude" ? "/v1/messages" : format === "responses" ? "/v1/responses" : "/v1/chat/completions";

  let result;
  try {
    result = await execute({ req: chatReq, rawClaude, clientHeaders: req.headers, endpoint, apiKeyId: auth.key?.id || null, requestedModel, signal: req.signal });
  } catch (e) {
    const err = e instanceof GatewayError ? e : new GatewayError(502, (e as Error).message);
    return errorBody(format, err.status, err.message, err.retryAfter);
  }
  const { chunks, toolNameMap } = result;
  const modelForClient = requestedModel;

  if (!stream) {
    const all: ChatChunk[] = [];
    try {
      for await (const c of chunks) all.push(decloak({ ...c, model: modelForClient }, toolNameMap));
    } catch (e) {
      return errorBody(format, 502, (e as Error).message, null);
    }
    if (format === "claude") {
      const st = newClaudeEncodeState(modelForClient);
      const content: unknown[] = [];
      let stop: string = "end_turn";
      let usage: unknown = { input_tokens: 0, output_tokens: 0 };
      const open = new Map<number, Record<string, unknown>>();
      for (const c of all) {
        for (const ev of encodeClaudeEvents(c, st)) {
          if (ev.type === "content_block_start") open.set(ev.index as number, { ...(ev.content_block as Record<string, unknown>) });
          else if (ev.type === "content_block_delta") {
            const b = open.get(ev.index as number)!;
            const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
            if (d.type === "text_delta") b.text = ((b.text as string) || "") + d.text;
            else if (d.type === "thinking_delta") b.thinking = ((b.thinking as string) || "") + d.thinking;
            else if (d.type === "input_json_delta") b._json = ((b._json as string) || "") + d.partial_json;
          } else if (ev.type === "content_block_stop") {
            const b = open.get(ev.index as number)!;
            if (b._json !== undefined) {
              try {
                b.input = JSON.parse(b._json as string);
              } catch {
                b.input = {};
              }
              delete b._json;
            }
            content.push(b);
          } else if (ev.type === "message_delta") {
            stop = (ev.delta as { stop_reason: string }).stop_reason;
            usage = ev.usage;
          }
        }
      }
      return NextResponse.json({ id: st.messageId, type: "message", role: "assistant", model: modelForClient, content, stop_reason: stop, stop_sequence: null, usage }, { headers: cors });
    }
    if (format === "responses") return NextResponse.json(responsesObjectFromChunks(all, modelForClient), { headers: cors });
    return NextResponse.json(completionFromChunks(all, modelForClient), { headers: cors });
  }

  const encoder = new TextEncoder();
  const claudeState = newClaudeEncodeState(modelForClient);
  const responsesState = newResponsesEncodeState(modelForClient);
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        for await (const raw of chunks) {
          const c = decloak({ ...raw, model: modelForClient }, toolNameMap);
          if (format === "claude") for (const ev of encodeClaudeEvents(c, claudeState)) send(sseLine(ev, ev.type as string));
          else if (format === "responses") for (const ev of encodeResponsesEvents(c, responsesState)) send(sseLine(ev.data, ev.event));
          else {
            const out: Record<string, unknown> = { ...c };
            if (c.usage) out.usage = usageForClient(c.usage);
            send(sseLine(out));
          }
        }
        if (format === "openai") send("data: [DONE]\n\n");
      } catch (e) {
        const message = (e as Error).message;
        if (format === "claude") send(sseLine({ type: "error", error: { type: "api_error", message } }, "error"));
        else if (format === "responses") send(sseLine({ type: "error", error: { message } }, "error"));
        else send(sseLine({ error: { message, type: "api_error" } }));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(readable, { headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

/** Models visible to clients: combos plus every model of every connected provider. */
export function visibleModels(key: ApiKey | null) {
  const connected = new Set(listConnections({ activeOnly: true }).map((c) => c.provider));
  const models: { id: string; object: "model"; created: number; owned_by: string }[] = [];
  const created = Math.floor(Date.now() / 1000);
  for (const combo of listCombos()) models.push({ id: combo.name, object: "model", created, owned_by: "combo" });
  for (const p of Object.values(PROVIDERS)) {
    if (!connected.has(p.id)) continue;
    for (const m of p.models) models.push({ id: `${p.alias}/${m.id}`, object: "model", created, owned_by: p.id });
  }
  const allow = key?.allowedModels;
  return allow?.length ? models.filter((m) => allow.includes(m.id)) : models;
}

export function handleModels(req: Request) {
  const auth = authenticate(req);
  if (!auth.ok) return errorBody("openai", 401, "Invalid or missing API key", null);
  return NextResponse.json({ object: "list", data: visibleModels(auth.key) }, { headers: cors });
}
