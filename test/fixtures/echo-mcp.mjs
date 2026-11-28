// Minimal stdio MCP server for tests: tools "echo" and "secret", plus "boom" that throws.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const label = process.env.ECHO_LABEL || "echo";
const server = new Server({ name: label, version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "secret", description: "Disabled in tests", inputSchema: { type: "object", properties: {} } },
    { name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "boom") throw new Error("kaboom");
  return { content: [{ type: "text", text: `${label}:${req.params.name}:${req.params.arguments?.text ?? ""}` }] };
});
await server.connect(new StdioServerTransport());
