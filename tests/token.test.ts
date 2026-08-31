import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { token } from "../src/commands/token.js";

const API_URL = "http://ahood.test";

function stubApi(status: number, body: unknown) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? "GET" });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

describe("token", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects an unknown subcommand", async () => {
    await expect(token(["bogus"])).rejects.toThrow(/Usage: ahood token/);
  });

  it("dispatches 'create' and prints the one-time secret", async () => {
    stubApi(200, { token: "ahd_abc123", name: "ci" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await token(["create", "ci"]);

    expect(logSpy).toHaveBeenCalledWith('Created token "ci": ahd_abc123');
  });

  it("'list --json' prints the raw token array", async () => {
    const tokens = [{ id: "t1", name: "ci", token_prefix: "ahd_ab", scopes: ["publish"], revoked_at: null, created_at: "2026-01-01" }];
    stubApi(200, { tokens });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await token(["list", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(tokens));
  });

  it("'revoke' DELETEs the URL-encoded token id", async () => {
    const calls = stubApi(200, {});

    await token(["revoke", "abc def"]);

    expect(calls).toEqual([{ url: `${API_URL}/api/v1/auth/tokens/abc%20def`, method: "DELETE" }]);
  });
});
