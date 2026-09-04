import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { CLI_VERSION } from "../version.js";

// Split from startMcpServer so tests can build a server and connect it to an
// InMemoryTransport instead of real stdio.
export function buildServer(): McpServer {
  const server = new McpServer({ name: "ahood", version: CLI_VERSION });
  registerTools(server);
  return server;
}

// Connects over stdio and blocks: StdioServerTransport reads process.stdin
// for the life of the process. This is expected -- an MCP host spawns
// `ahood mcp` as a long-lived subprocess and talks to it over stdio for as
// long as the session lasts.
export async function startMcpServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
