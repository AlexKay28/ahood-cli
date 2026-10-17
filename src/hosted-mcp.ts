// One call to a tool on the hosted registry MCP endpoint (/api/mcp), for the
// reads that have no REST route -- today only get_project_guide
// (ahood-cli#185). The endpoint is stateless and answers plain JSON
// (enableJsonResponse), so a bare JSON-RPC `tools/call` through apiJson -- the
// same auth, error mapping and retry as every REST call -- is the whole
// client; no session or initialize handshake is needed.
import { apiJson } from "./http.js";
import { sanitizeForTerminal } from "./terminal-safe.js";

type ToolCallResponse = {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function callHostedTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await apiJson<ToolCallResponse>("/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (response.error) throw new Error(`${name} failed: ${sanitizeForTerminal(response.error.message ?? "unknown error")}`);
  const text = response.result?.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new Error(`${name} returned no content.`);
  const payload = parseJson(text) as (T & { error?: unknown }) | undefined;
  if (response.result?.isError) {
    const reason = typeof payload?.error === "string" ? payload.error : text;
    throw new Error(`${name} failed: ${sanitizeForTerminal(reason)}`);
  }
  if (payload === undefined) throw new Error(`${name} returned a response that is not JSON.`);
  return payload;
}
