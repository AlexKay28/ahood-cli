import { startMcpServer } from "../mcp/server.js";

// Starts the local stdio MCP server -- reached as bare `ahood mcp` (the
// original v1 contract, kept byte-for-byte for existing host configs) or
// `ahood mcp serve`; index.ts's dispatchMcp() decides which first words mean
// "serve" and which are registry verbs (ahood-cli#172). Unlike every other
// command it never returns until the client disconnects -- see
// startMcpServer's comment.
export async function mcp(_args: string[]): Promise<void> {
  await startMcpServer();
}
