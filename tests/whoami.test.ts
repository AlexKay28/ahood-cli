import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { whoami } from "../src/commands/whoami.js";

const API_URL = "http://ahood.test";

function stubApi(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

describe("whoami", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
    process.exitCode = 0;
  });

  it("exits non-zero when no token is configured at all", async () => {
    delete process.env.AHOOD_TOKEN;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await whoami([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Not logged in/));
    expect(process.exitCode).toBe(1);
  });

  it("reports success for a session-backed token (200)", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApi(200, { tokens: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami([]);
    expect(logSpy).toHaveBeenCalledWith("Authenticated.");
    expect(process.exitCode).toBe(0);
  });

  it("reports success for a personal API token (403)", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApi(403, { error: "session required" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami([]);
    expect(logSpy).toHaveBeenCalledWith("Authenticated with a personal API token.");
    expect(process.exitCode).toBe(0);
  });

  it("exits non-zero with an 'invalid or revoked' message on 401", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApi(401, { error: "unauthorized" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await whoami([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid or has been revoked/));
    expect(process.exitCode).toBe(1);
  });

  it("distinguishes a network/server failure from an invalid token", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApi(500, { error: "database is down" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await whoami([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Could not verify your token/));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringMatching(/invalid or has been revoked/));
    expect(process.exitCode).toBe(1);
  });

  it("--json emits a structured result instead of prose", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApi(200, { tokens: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami(["--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ authenticated: true, mode: "session" }));
  });
});
