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
    vi.useRealTimers();
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

  // ahood-cli#159: a 429 from the poll endpoint means "stop asking so often".
  // The loop must back off by Retry-After (exponentially when absent) instead
  // of continuing on its normal cadence -- the retry-storm shape -- while
  // still terminating at the login deadline. Timings below run on fake
  // timers and are asserted exactly.
  describe("poll loop rate limiting (ahood-cli#159)", () => {
    function stubDeviceFlow(poll: (count: number) => Response): { pollCalls: string[] } {
      const pollCalls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === `${API_URL}/api/v1/auth/cli/device`) {
            return new Response(
              JSON.stringify({ code: "ABCD", verification_url: `${API_URL}/cli-auth?code=ABCD`, expires_in: 600 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.startsWith(`${API_URL}/api/v1/auth/cli/device/`)) {
            pollCalls.push(url);
            return poll(pollCalls.length);
          }
          return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
        }),
      );
      return { pollCalls };
    }

    function rateLimited(status: number, headers: Record<string, string> = {}): Response {
      return new Response(JSON.stringify({ error: "slow down" }), { status, headers });
    }

    it("backs off by Retry-After on a 429 and still logs in once the limit clears", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { pollCalls } = stubDeviceFlow((n) =>
        n === 1 ? rateLimited(429, { "Retry-After": "3" }) : new Response(JSON.stringify({ status: "approved", token: "ahd_tok" }), { status: 200 }),
      );

      const outcome = expect(login()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000); // the normal first poll
      expect(pollCalls).toHaveLength(1); // got the 429
      await vi.advanceTimersByTimeAsync(2_999); // still backing off: the server asked for 3s, more than the usual 2s
      expect(pollCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(pollCalls).toHaveLength(2);
      expect(JSON.parse(readFileSync(join(dir, ".config", "ahood", "credentials.json"), "utf-8"))).toEqual({ token: "ahd_tok" });
      // The user is told why the poll went quiet.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/rate limited/i));
    });

    it("backs off exponentially (1s, then 2s) when the 429 carries no Retry-After", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { pollCalls } = stubDeviceFlow((n) =>
        n <= 2 ? rateLimited(429) : new Response(JSON.stringify({ status: "approved", token: "ahd_tok" }), { status: 200 }),
      );

      const outcome = expect(login()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(pollCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(pollCalls).toHaveLength(1); // first backoff: 1s
      await vi.advanceTimersByTimeAsync(1);
      expect(pollCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(pollCalls).toHaveLength(2); // second backoff doubled to 2s
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(pollCalls).toHaveLength(3);
    });

    it("gives up at the login deadline when the registry keeps rate limiting, never polling past it", async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      // A short window (5s) with a persistent 1s Retry-After: polls land at
      // t=2s, 3s, 4s; the next 1s backoff would reach exactly the deadline,
      // so the loop stops there instead of sleeping past expires_in.
      const pollCalls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === `${API_URL}/api/v1/auth/cli/device`) {
            return new Response(
              JSON.stringify({ code: "ABCD", verification_url: `${API_URL}/cli-auth?code=ABCD`, expires_in: 5 }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.startsWith(`${API_URL}/api/v1/auth/cli/device/`)) {
            pollCalls.push(url);
            return rateLimited(429, { "Retry-After": "1" });
          }
          return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
        }),
      );

      const outcome = expect(login()).rejects.toThrow(/rate limit/i);
      await vi.advanceTimersByTimeAsync(60_000); // far past every backoff the loop could schedule
      await outcome;

      expect(pollCalls).toHaveLength(3);
      // The timeout error blames the rate limiting, not the user's pace.
    });
  });
});
