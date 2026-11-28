import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slimrouter-mcp-"));

const { upsertServer, publicServer, mergeSecrets, getServer } = await import("@/server/mcp/registry");
const { handleMcpRequest, splitToolName } = await import("@/server/mcp/gateway");
const { closeUpstream } = await import("@/server/mcp/upstream");
const { createApiKey, verifyApiKey } = await import("@/server/apikeys");
const { planMcphubImport } = await import("@/server/mcp/import");

const FIXTURE = path.resolve(__dirname, "fixtures/echo-mcp.mjs");

// Route the SDK client straight into the gateway handler, as Next would.
function clientFor(plaintext: string, scope: string | null) {
  const url = new URL(scope ? `http://slim.test/mcp/${scope}` : "http://slim.test/mcp");
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = verifyApiKey(req.headers.get("authorization")?.slice(7) ?? null);
    if (!key) return new Response("unauthorized", { status: 401 });
    return handleMcpRequest(req, key, scope);
  };
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${plaintext}` } }, fetch: fetchImpl as typeof fetch });
  return { client: new Client({ name: "test", version: "1" }), transport };
}

describe("MCP gateway", () => {
  let all: string;
  let onlyA: string;
  let none: string;

  beforeAll(() => {
    for (const label of ["alpha", "beta"]) {
      upsertServer({ name: label, transport: "stdio", config: { command: process.execPath, args: [FIXTURE], env: { ECHO_LABEL: label }, tools: { secret: { enabled: false } } } });
    }
    all = createApiKey("all", null, ["*"]).plaintext;
    onlyA = createApiKey("only-alpha", null, ["alpha"]).plaintext;
    none = createApiKey("models-only").plaintext;
  });

  afterAll(async () => {
    await closeUpstream("alpha");
    await closeUpstream("beta");
  });

  it("aggregates every allowed server with prefixed names and hides disabled tools", async () => {
    const { client, transport } = clientFor(all, null);
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["alpha__boom", "alpha__echo", "beta__boom", "beta__echo"]);
    const r = await client.callTool({ name: "beta__echo", arguments: { text: "hi" } });
    expect((r.content as { text: string }[])[0].text).toBe("beta:echo:hi");
    await client.close();
  }, 30_000);

  it("only shows the servers a key may reach and refuses the rest", async () => {
    const { client, transport } = clientFor(onlyA, null);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["alpha__boom", "alpha__echo"]);
    const r = await client.callTool({ name: "beta__echo", arguments: { text: "x" } });
    expect(r.isError).toBe(true);
    const d = await client.callTool({ name: "alpha__secret", arguments: {} });
    expect(d.isError).toBe(true);
    await client.close();
  }, 30_000);

  it("serves one server with its original tool names at /mcp/<name>", async () => {
    const { client, transport } = clientFor(all, "alpha");
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
    const r = await client.callTool({ name: "echo", arguments: { text: "solo" } });
    expect((r.content as { text: string }[])[0].text).toBe("alpha:echo:solo");
    const failed = await client.callTool({ name: "boom", arguments: {} });
    expect(failed.isError).toBe(true);
    await client.close();
  }, 30_000);

  it("keeps keys made before MCP model-only", async () => {
    const key = verifyApiKey(none)!;
    expect(key.allowedMcp).toBeNull();
    const res = await handleMcpRequest(new Request("http://slim.test/mcp/alpha", { method: "POST", body: "{}" }), key, "alpha");
    expect(res.status).toBe(404);
  });

  it("splits aggregated tool names on the first separator", () => {
    expect(splitToolName("opm-sql__db_query", null)).toEqual({ server: "opm-sql", tool: "db_query" });
    expect(splitToolName("a__b__c", null)).toEqual({ server: "a", tool: "b__c" });
    expect(splitToolName("nosep", null)).toBeNull();
    expect(splitToolName("db_query", "opm-sql")).toEqual({ server: "opm-sql", tool: "db_query" });
  });
});

describe("MCP registry secrets", () => {
  it("masks env and headers and keeps stored values when the dashboard sends the mask back", () => {
    const s = upsertServer({ name: "remote", transport: "http", config: { url: "https://example.test/mcp", headers: { Authorization: "Bearer real" } } });
    expect(JSON.stringify(publicServer(s))).not.toContain("real");
    const merged = mergeSecrets(getServer("remote"), { name: "remote", transport: "http", config: { url: "https://example.test/mcp2", headers: { Authorization: "••••", "X-New": "v" } } });
    upsertServer(merged);
    const after = getServer("remote")!;
    expect(after.transport === "http" && after.config.headers).toEqual({ Authorization: "Bearer real", "X-New": "v" });
  });
});

describe("mcphub import", () => {
  const settings = {
    mcpServers: {
      unraidclaw: { type: "stdio", command: "node", args: ["/mcp-servers/unraidclaw-mcp-proxy/index.cjs"], env: { UNRAIDCLAW_API_KEY: "k" }, options: { timeout: 900000 } },
      "obsidian-vault": { type: "stdio", command: "setpriv", args: ["--reuid=99", "--", "sh", "-c", "umask 002 && exec npx -y @modelcontextprotocol/server-filesystem /vaults"] },
      cloudflare: { type: "streamable-http", url: "https://mcp.cloudflare.com/mcp", headers: { Authorization: "Bearer x" }, enabled: true },
      "tidb-legacy": { type: "stdio", command: "uvx", enabled: false },
      Bad_Name: { type: "stdio", command: "x" },
    },
    bearerKeys: [
      { name: "Paseo Key", enabled: true, accessType: "all", allowedServers: [] },
      { name: "OpenBot", enabled: true, accessType: "servers", allowedServers: ["unraidclaw", "cloudflare"] },
    ],
  };

  it("plans servers, maps container paths and carries key scopes as hints", () => {
    const plan = planMcphubImport(settings, { pathMap: { "/mcp-servers": "/srv/mcp", "/vaults": "/data/vaults" }, skip: ["tidb-legacy"] });
    const by = Object.fromEntries(plan.servers.map((s) => [s.name, s]));
    expect(by.unraidclaw.transport).toBe("stdio");
    expect(by.unraidclaw.input?.transport === "stdio" && by.unraidclaw.input.config.args).toEqual(["/srv/mcp/unraidclaw-mcp-proxy/index.cjs"]);
    expect(by.unraidclaw.input?.config.timeoutMs).toBe(900000);
    const vault = by["obsidian-vault"].input;
    expect(vault?.transport === "stdio" ? vault.config.args?.at(-1) : "").toContain("server-filesystem /data/vaults");
    expect(by.cloudflare.transport).toBe("http");
    expect(by["tidb-legacy"].action).toBe("skip");
    expect(by.Bad_Name.action).toBe("skip");
    expect(plan.keyHints).toEqual([
      { name: "Paseo Key", servers: "all" },
      { name: "OpenBot", servers: ["unraidclaw", "cloudflare"] },
    ]);
  });
});

describe("stdio child environment", () => {
  it("passes cache and locale variables through and lets the server env win", async () => {
    const { childEnv } = await import("@/server/mcp/upstream");
    process.env.UV_CACHE_DIR = "/data/cache/uv";
    process.env.SECRET_OF_THE_GATEWAY = "no";
    const env = childEnv({ HOME: "/srv/home", UV_CACHE_DIR: "/custom" });
    expect(env.HOME).toBe("/srv/home");
    expect(env.UV_CACHE_DIR).toBe("/custom");
    expect(env.SECRET_OF_THE_GATEWAY).toBeUndefined();
    expect(childEnv({}).UV_CACHE_DIR).toBe("/data/cache/uv");
  });
});
