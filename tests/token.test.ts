import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
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

// `token revoke` (without --yes) reads a confirmation line from stdin via
// the same node:readline-based confirm() unpublish uses -- feed it one
// directly instead of touching the real terminal, and capture what gets
// written to stdout as the prompt.
function stubStdio(answer: string): { promptedWith(): string } {
  const written: string[] = [];
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
  const fakeStdout = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream & { fd: 1 };
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(fakeStdout);
  queueMicrotask(() => {
    fakeStdin.push(`${answer}\n`);
    fakeStdin.push(null);
  });
  return { promptedWith: () => written.join("") };
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

  it("'revoke --yes' skips the prompt entirely and DELETEs the URL-encoded token id immediately", async () => {
    const calls = stubApi(200, {});

    await token(["revoke", "abc def", "--yes"]);

    // A single DELETE call only -- no name/prefix lookup GET either, so
    // scripts/CI relying on the original one-shot behavior see no extra
    // latency or API calls.
    expect(calls).toEqual([{ url: `${API_URL}/api/v1/auth/tokens/abc%20def`, method: "DELETE" }]);
  });

  it("'revoke' without --yes prompts, and does NOT call DELETE when the answer isn't exactly 'yes'", async () => {
    const calls = stubApi(200, { tokens: [] });
    const stdio = stubStdio("no");

    await token(["revoke", "tok-1"]);

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(stdio.promptedWith()).toMatch(/Revoke token tok-1\?/);
  });

  it("'revoke' without --yes DELETEs once the user confirms with 'yes'", async () => {
    const calls = stubApi(200, { tokens: [] });
    stubStdio("yes");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await token(["revoke", "tok-1"]);

    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toEqual([{ url: `${API_URL}/api/v1/auth/tokens/tok-1`, method: "DELETE" }]);
    expect(logSpy).toHaveBeenCalledWith("Revoked tok-1");
  });

  it("'revoke' prompt shows the token's name/prefix when it can be looked up via the list endpoint", async () => {
    const tokens = [
      { id: "tok-1", name: "ci-runner", token_prefix: "ahd_ab", scopes: ["publish"], revoked_at: null, created_at: "2026-01-01" },
    ];
    stubApi(200, { tokens });
    const stdio = stubStdio("no");

    await token(["revoke", "tok-1"]);

    expect(stdio.promptedWith()).toMatch(/Revoke token "ci-runner" \(ahd_ab\.\.\.\)\?/);
  });

  it("'revoke' prompt falls back to the bare id when the lookup doesn't find a matching token", async () => {
    stubApi(200, { tokens: [] });
    const stdio = stubStdio("no");

    await token(["revoke", "tok-unknown"]);

    expect(stdio.promptedWith()).toMatch(/Revoke token tok-unknown\?/);
  });
});
