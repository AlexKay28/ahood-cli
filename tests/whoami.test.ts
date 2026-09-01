import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whoami } from "../src/commands/whoami.js";

const API_URL = "http://ahood.test";

function stubApi(status: number, body: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

// Routes /api/v1/auth/tokens and /api/v1/profile to independent
// status/body pairs, keyed by the request URL's pathname -- whoami now
// calls both endpoints in sequence, and the two need to be able to
// succeed/fail independently to exercise the profile-enrichment fallback.
function stubApiRoutes(routes: Record<string, { status: number; body?: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const route = routes[pathname];
      if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

describe("whoami", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let dir: string;

  beforeEach(() => {
    // resolveToken() falls back to ~/.config/ahood/credentials.json when
    // AHOOD_TOKEN is unset -- point HOME at an empty temp dir so that
    // fallback can never pick up a real (or another test's) file, whatever
    // order/worker this file happens to run in.
    dir = mkdtempSync(join(tmpdir(), "ahood-whoami-test-"));
    process.env.HOME = dir;
    delete process.env.XDG_CONFIG_HOME;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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

  it("reports success for a session-backed token (200) when the profile fetch also fails", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    // /api/v1/profile is left unstubbed (404s) to exercise the fallback path.
    stubApiRoutes({ "/api/v1/auth/tokens": { status: 200, body: { tokens: [] } } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami([]);
    expect(logSpy).toHaveBeenCalledWith("Authenticated.");
    expect(process.exitCode).toBe(0);
  });

  it("reports success for a personal API token (403) when the profile fetch also fails", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApiRoutes({ "/api/v1/auth/tokens": { status: 403, body: { error: "session required" } } });
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

  it("--json emits a structured result instead of prose when the profile fetch also fails", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApiRoutes({ "/api/v1/auth/tokens": { status: 200, body: { tokens: [] } } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami(["--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ authenticated: true, mode: "session" }));
  });

  const profileBody = {
    username: "alexkay",
    display_name: "Alex Kay",
    bio: "Building ahood.",
    avatar_url: "https://ahood.test/avatars/alexkay.png",
    github_username: "AlexKay28",
  };

  it("includes the username in the human-readable output for a personal token (403) on profile success", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApiRoutes({
      "/api/v1/auth/tokens": { status: 403, body: { error: "session required" } },
      "/api/v1/profile": { status: 200, body: profileBody },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami([]);
    expect(logSpy).toHaveBeenCalledWith("Authenticated as alexkay (personal API token).");
    expect(process.exitCode).toBe(0);
  });

  it("includes the username in the human-readable output for a session token (200) on profile success", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApiRoutes({
      "/api/v1/auth/tokens": { status: 200, body: { tokens: [] } },
      "/api/v1/profile": { status: 200, body: profileBody },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami([]);
    expect(logSpy).toHaveBeenCalledWith("Authenticated as alexkay.");
    expect(process.exitCode).toBe(0);
  });

  it("--json includes the profile fields alongside authenticated/mode on profile success", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApiRoutes({
      "/api/v1/auth/tokens": { status: 403, body: { error: "session required" } },
      "/api/v1/profile": { status: 200, body: profileBody },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami(["--json"]);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ authenticated: true, mode: "token", ...profileBody }),
    );
  });

  it("falls back gracefully without crashing when the profile fetch fails (network error)", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const pathname = new URL(url).pathname;
        if (pathname === "/api/v1/auth/tokens") {
          return new Response(JSON.stringify({ error: "session required" }), { status: 403 });
        }
        throw new TypeError("fetch failed");
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami([]);
    expect(logSpy).toHaveBeenCalledWith("Authenticated with a personal API token.");
    expect(process.exitCode).toBe(0);
  });

  it("falls back gracefully without crashing when the profile fetch 500s", async () => {
    process.env.AHOOD_TOKEN = "tok_test";
    stubApiRoutes({
      "/api/v1/auth/tokens": { status: 403, body: { error: "session required" } },
      "/api/v1/profile": { status: 500, body: { error: "database is down" } },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await whoami(["--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ authenticated: true, mode: "token" }));
    expect(process.exitCode).toBe(0);
  });
});
