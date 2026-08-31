import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../src/commands/login.js";

const API_URL = "http://ahood.test";
const EVIL_URL = "http://evil.example.com";

describe("login", () => {
  let dir: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-login-test-"));
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    // Real timers, not fake ones: login()'s poll loop does a real network
    // round-trip (via apiJson) before its first sleep(2000), and how many
    // microtask hops that takes before the first fake timer gets registered
    // is sensitive to Node version / event-loop scheduling under load --
    // exactly the kind of thing that's fast and reliable locally but flaky
    // on a loaded CI runner. These tests only need ONE real 2s sleep each
    // (both stub the first poll response as immediately "approved"), so
    // paying that wall-clock cost buys determinism.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("polls the CONFIGURED API host, not a host derived from verification_url", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === `${API_URL}/api/v1/auth/cli/device`) {
          return new Response(
            JSON.stringify({ code: "ABCD", verification_url: `${EVIL_URL}/cli-auth?code=ABCD`, expires_in: 600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith(`${API_URL}/api/v1/auth/cli/device/`)) {
          return new Response(JSON.stringify({ status: "approved", token: "ahd_tok" }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await login();

    expect(calls.some((u) => u.startsWith(EVIL_URL))).toBe(false);
    expect(calls.some((u) => u.startsWith(`${API_URL}/api/v1/auth/cli/device/`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".config", "ahood", "credentials.json"), "utf-8"))).toEqual({
      token: "ahd_tok",
    });
  });

  it("still polls (does not time out instantly) when expires_in is missing/invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/auth/cli/device`) {
          // expires_in deliberately omitted -- previously produced
          // Date.now() + undefined * 1000 = NaN, so the poll loop's
          // condition (Date.now() < NaN) was always false and login failed
          // instantly instead of ever polling.
          return new Response(
            JSON.stringify({ code: "ABCD", verification_url: `${API_URL}/cli-auth?code=ABCD` }),
            { status: 200 },
          );
        }
        if (url.startsWith(`${API_URL}/api/v1/auth/cli/device/`)) {
          return new Response(JSON.stringify({ status: "approved", token: "ahd_tok" }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await login();

    expect(existsSync(join(dir, ".config", "ahood", "credentials.json"))).toBe(true);
  });
});
