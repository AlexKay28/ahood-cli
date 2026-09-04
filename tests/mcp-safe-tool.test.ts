import { describe, expect, it } from "vitest";
import { safeTool, errorCodeFor } from "../src/mcp/safe-tool.js";
import { ApiError, NetworkError } from "../src/http.js";
import { UsageError } from "../src/usage-error.js";

describe("errorCodeFor", () => {
  it("maps UsageError to usage_error", () => {
    expect(errorCodeFor(new UsageError("bad input"))).toBe("usage_error");
  });

  it("maps ApiError 401/403 to auth_error", () => {
    expect(errorCodeFor(new ApiError(401, "unauthorized"))).toBe("auth_error");
    expect(errorCodeFor(new ApiError(403, "forbidden"))).toBe("auth_error");
  });

  it("maps ApiError 404 to not_found", () => {
    expect(errorCodeFor(new ApiError(404, "not found"))).toBe("not_found");
  });

  it("maps ApiError 5xx to network_error", () => {
    expect(errorCodeFor(new ApiError(500, "internal error"))).toBe("network_error");
  });

  it("maps other ApiError statuses to usage_error", () => {
    expect(errorCodeFor(new ApiError(400, "bad request"))).toBe("usage_error");
  });

  it("maps NetworkError to network_error", () => {
    expect(errorCodeFor(new NetworkError("fetch failed"))).toBe("network_error");
  });

  it("maps anything else to general_error", () => {
    expect(errorCodeFor(new Error("boom"))).toBe("general_error");
  });
});

describe("safeTool", () => {
  it("returns the function's result as JSON text content on success", async () => {
    const wrapped = safeTool(async (input: { n: number }) => ({ doubled: input.n * 2 }));

    const result = await wrapped({ n: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ doubled: 6 }) }]);
  });

  it("catches a thrown error and returns an isError result with error and error_code", async () => {
    const wrapped = safeTool(async () => {
      throw new UsageError("Usage: ahood skill search <query>");
    });

    const result = await wrapped({});

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(body).toEqual({ error: "Usage: ahood skill search <query>", error_code: "usage_error" });
  });
});
