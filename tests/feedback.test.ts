// `ahood feedback` (ahood#1673): POST /api/v1/feedback, anonymous or logged in.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedback } from "../src/commands/feedback.js";
import { COMMANDS } from "../src/index.js";
import { findCommandHelp } from "../src/help.js";
import { CLI_VERSION } from "../src/version.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("ahood feedback", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let out: string[];
  let requests: { url: string; init: RequestInit }[];

  function serve(respond: () => Response) {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ url: String(input), init });
        return respond();
      }),
    );
  }
  const sent = () => JSON.parse(String(requests[0].init.body));
  const header = (name: string) => new Headers(requests[0].init.headers).get(name);

  beforeEach(() => {
    process.env.AHOOD_API_URL = "http://ahood.test";
    delete process.env.AHOOD_TOKEN;
    // No stored login on the test machine may leak into the anonymous case.
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ahood-feedback-"));
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("sends JSON with the default kind, the cli surface header and the CLI version, anonymously", async () => {
    serve(() => json({ id: "f1" }, 201));
    await feedback(["search", "is", "slow"]);
    expect(requests[0].url).toBe("http://ahood.test/api/v1/feedback");
    expect(requests[0].init.method).toBe("POST");
    expect(header("Content-Type")).toBe("application/json");
    expect(header("X-Ahood-Source")).toBe("cli");
    expect(header("Authorization")).toBeNull();
    expect(sent()).toEqual({ kind: "idea", message: "search is slow", context: { surface: "cli", cli_version: CLI_VERSION } });
    expect(out.join("\n")).toContain("feedback was sent");
  });

  it("passes --kind, --query and --artifact, and attaches the token when logged in", async () => {
    process.env.AHOOD_TOKEN = "ahood_test_token";
    serve(() => json({ id: "f2" }, 201));
    await feedback(["nothing found", "--kind", "search_miss", "--query", "pdf tools", "--artifact=alice/pdf"]);
    expect(header("Authorization")).toBe("Bearer ahood_test_token");
    expect(sent()).toMatchObject({
      kind: "search_miss",
      message: "nothing found",
      context: { query: "pdf tools", artifact: "alice/pdf", surface: "cli" },
    });
  });

  it("rejects a missing message, a bad kind, an unknown flag and an oversized message before any request", async () => {
    serve(() => json({}, 201));
    await expect(feedback([])).rejects.toThrow(/Usage: ahood feedback/);
    await expect(feedback(["hi", "--kind", "rant"])).rejects.toThrow(/--kind must be one of/);
    await expect(feedback(["hi", "--all"])).rejects.toThrow(/Unknown argument: --all/);
    await expect(feedback(["x".repeat(4001)])).rejects.toThrow(/limit is 4000/);
    expect(requests).toEqual([]);
  });

  it("explains a rejected secret", async () => {
    serve(() => json({ error: "Feedback looks like it contains a secret or token. Remove it and send again." }, 400));
    await expect(feedback(["my key is abc"])).rejects.toThrow(/looks like it contains a secret or token/);
  });

  it("passes through other 400 messages", async () => {
    serve(() => json({ error: "Feedback must be plain text without control characters." }, 400));
    await expect(feedback(["hi"])).rejects.toThrow(/Feedback was rejected: Feedback must be plain text/);
  });

  it("explains 403 (scope) and 415", async () => {
    serve(() => json({ error: "forbidden" }, 403));
    await expect(feedback(["hi"])).rejects.toThrow(/'publish' scope/);
    serve(() => json({ error: "bad type" }, 415));
    await expect(feedback(["hi"])).rejects.toThrow(/expected JSON/);
  });

  it("explains 429 as try later", async () => {
    vi.useFakeTimers();
    try {
      serve(() => json({ error: "slow down" }, 429, { "Retry-After": "1" }));
      const result = expect(feedback(["hi"])).rejects.toThrow(/Try again later/);
      await vi.runAllTimersAsync();
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a registered command with help", () => {
    expect(COMMANDS.feedback).toBeTypeOf("function");
    expect(findCommandHelp("feedback")?.usage).toContain("ahood feedback");
  });
});
