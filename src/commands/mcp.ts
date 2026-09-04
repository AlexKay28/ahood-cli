import { startMcpServer } from "../mcp/server.js";

// `ahood mcp` takes no subcommands/flags in v1. Unlike every other
// account-scoped command it never returns until the client disconnects --
// see startMcpServer's comment.
export async function mcp(_args: string[]): Promise<void> {
  await startMcpServer();
}
