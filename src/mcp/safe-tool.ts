import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, NetworkError } from "../http.js";
import { UsageError } from "../usage-error.js";

export type ToolErrorCode = "usage_error" | "auth_error" | "not_found" | "network_error" | "general_error";

// Mirrors exit-code.ts's exitCodeFor categorization (ahood-cli#83) -- one
// error taxonomy for both the CLI's exit codes and MCP's error_code field,
// rather than maintaining two.
export function errorCodeFor(error: unknown): ToolErrorCode {
  if (error instanceof UsageError) return "usage_error";
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "auth_error";
    if (error.status === 404) return "not_found";
    if (error.status >= 500) return "network_error";
    return "usage_error";
  }
  if (error instanceof NetworkError) return "network_error";
  return "general_error";
}

// Wraps an MCP tool's data-fetching logic so a thrown error never crosses
// the stdio boundary as a raw exception -- caught here and turned into a
// structured isError result instead. `fn` is the tool's own core function
// (e.g. searchSkills), already adapted to take the single zod-validated
// input object each MCP tool callback receives.
export function safeTool<TInput>(
  fn: (input: TInput) => Promise<unknown>,
): (input: TInput) => Promise<CallToolResult> {
  return async (input: TInput) => {
    try {
      const result = await fn(input);
      // Defensive backstop: JSON.stringify(undefined) evaluates to the JS
      // value `undefined`, not a string -- if any tool's core function ever
      // returns undefined (e.g. a malformed API response missing an
      // expected key), the MCP SDK rejects that as an invalid tool result
      // and throws a raw protocol-level error instead of the structured
      // isError result this wrapper exists to guarantee. Coalescing to null
      // keeps `text` a string no matter what `fn` returns.
      return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const body = { error: message, error_code: errorCodeFor(error) };
      return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
    }
  };
}
