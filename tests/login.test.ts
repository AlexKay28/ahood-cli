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
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-login-test-"));
    process.env.HOME = dir;
    // writeCredentials() prefers XDG_CONFIG_HOME over HOME when set -- this
    // was unset, so on a CI runner that has it set ambiently, credentials
    // were being written outside `dir` entirely and the ENOENT/false
    // assertions below looked like a fake-timer race that switching to real
    // timers didn't actually fix.
    delete process.env.XDG_CONFIG_HOME;
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
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

  it("fails fast on a 410 with a non-JSON body instead of retrying it as a transient blip (#104)", async () => {
    const calls: string[] = [];
    const html = "<!DOCTYPE html>\n<html><head><title>410 Gone</title></head><body>nginx</body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === `${API_URL}/api/v1/auth/cli/device`) {
          return new Response(
            JSON.stringify({ code: "ABCD", verification_url: `${API_URL}/cli-auth?code=ABCD`, expires_in: 600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith(`${API_URL}/api/v1/auth/cli/device/`)) {
          // A 410 (cancelled/expired) whose body is an HTML error page, not
          // JSON -- res.json() throwing on this must not fall into the
          // generic "transient, retry" path.
          return new Response(html, { status: 410, headers: { "Content-Type": "text/html" } });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await expect(login()).rejects.toThrow(/cancelled or expired/);

    // Exactly one poll attempt (plus the initial device-code request) --
    // if the old code path were still active, res.json() would throw before
    // the 410 check ever ran, get caught by the generic retry handler, and
    // this would still be looping (every 2s, up to 10 minutes) instead of
    // having already thrown.
    expect(calls.filter((u) => u.startsWith(`${API_URL}/api/v1/auth/cli/device/`))).toHaveLength(1);
  });
});
