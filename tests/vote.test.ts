import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { vote } from "../src/commands/vote.js";
import { view } from "../src/commands/view.js";
import { read } from "../src/commands/read.js";
import { ApiError } from "../src/http.js";
import { printRateHint } from "../src/rate-hint.js";
import type { KindScope } from "../src/kinds.js";

const AGENT_SCOPE: KindScope = { noun: "agent", kind: "agent" };

const API_URL = "http://ahood.test";

type Call = { url: string; init: RequestInit };

function stubApi(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

function lastLog(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("ahood vote (ahood#1640)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
    process.stdout.isTTY = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.stdout.isTTY = originalIsTTY;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  describe("vote", () => {
    it("rejects bad usage before any request", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(vote([])).rejects.toThrow(/Usage: ahood skill vote/);
      await expect(vote(["alice/demo"])).rejects.toThrow(/Usage: ahood skill vote/);
      await expect(vote(["alice/demo", "sideways"])).rejects.toThrow(/Usage: ahood skill vote/);
      await expect(vote(["alice/demo", "up", "--bogus"])).rejects.toThrow(/Unknown argument: --bogus/);
      await expect(vote(["alice/demo", "up", "--clear"])).rejects.toThrow(/--clear takes no up\|down/);
      await expect(vote(["alice/demo", "--clear", "--note", "x"])).rejects.toThrow(/cannot be combined/);
      await expect(vote(["alice/demo", "up", "--note", "x".repeat(501)])).rejects.toThrow(/limit is 500/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POSTs {value, version, note} and prints the new tally", async () => {
      const calls = stubApi(200, { value: "up", upvotes: 12, downvotes: 3 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await vote(["alice/demo", "up", "--note", "worked fine", "--version", "1.2.3"]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/alice/demo/vote`);
      expect(calls[0].init.method).toBe("POST");
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ value: "up", version: "1.2.3", note: "worked fine" });
      expect(new Headers(calls[0].init.headers).get("Authorization")).toBe("Bearer tok_test");
      expect(lastLog(log)).toBe("Upvoted alice/demo (▲12 ▼3).");
    });

    it("omits version and note when not given, and says Downvoted for down", async () => {
      const calls = stubApi(200, { value: "down", upvotes: 1, downvotes: 4 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await vote(["alice/demo", "down"]);

      expect(JSON.parse(String(calls[0].init.body))).toEqual({ value: "down" });
      expect(lastLog(log)).toBe("Downvoted alice/demo (▲1 ▼4).");
    });

    it("--clear sends DELETE and prints the cleared line", async () => {
      const calls = stubApi(200, { value: null, upvotes: 2, downvotes: 0 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await vote(["alice/demo", "--clear"]);

      expect(calls[0].init.method).toBe("DELETE");
      expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/alice/demo/vote`);
      expect(lastLog(log)).toBe("Cleared your vote on alice/demo.");
    });

    it("--json prints the server's {value, upvotes, downvotes}", async () => {
      stubApi(200, { value: "up", upvotes: 5, downvotes: 0 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await vote(["alice/demo", "up", "--json"]);

      expect(JSON.parse(lastLog(log))).toEqual({ value: "up", upvotes: 5, downvotes: 0 });
    });

    it("turns vote_requires_use into friendly advice that names the kind's own commands", async () => {
      stubApi(403, { error: "install or read it first", code: "vote_requires_use" });
      const err = await vote(["alice/demo", "up"]).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(403);
      expect(err.message).toMatch(/only vote on something you have used/);
      expect(err.message).toContain("ahood skill add alice/demo");
      expect(err.message).toContain("ahood skill read alice/demo");
    });

    it("turns cannot_vote_own into a clear message", async () => {
      stubApi(403, { error: "no", code: "cannot_vote_own" });
      await expect(vote(["alice/demo", "up"])).rejects.toThrow(/yours .* cannot vote on your own/);
    });

    it("passes other server errors through (scope 403 without a code, 404)", async () => {
      stubApi(403, { error: "This token's scopes do not include 'publish'" });
      await expect(vote(["alice/demo", "up"])).rejects.toThrow(/publish/);
      stubApi(404, { error: "Skill not found" });
      await expect(vote(["alice/demo", "up"])).rejects.toThrow(/not found/);
    });

    it("is refused for the wrong kind before voting, and usage names the noun", async () => {
      const calls = stubApi(200, { kind: "skill" });
      await expect(vote(["alice/demo", "up"], AGENT_SCOPE)).rejects.toThrow(/not an agent/);
      expect(calls.every((c) => !c.url.endsWith("/vote"))).toBe(true);
      await expect(vote([], AGENT_SCOPE)).rejects.toThrow(/Usage: ahood agent vote/);
    });
  });

  describe("view", () => {
    const base = {
      slug: "demo",
      name: "Demo",
      tagline: null,
      license: null,
      visibility: "public",
      tags: [],
      homepage: null,
      repository: null,
      downloads_count: 33,
      stars_count: 5,
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
      owner: "alice",
      is_starred: null,
      skill_versions: { version: "1.0.0", checksum_sha256: "abc" },
    };

    it("sends X-Ahood-Usage: view", async () => {
      const calls = stubApi(200, base);
      vi.spyOn(console, "log").mockImplementation(() => {});
      await view(["alice/demo"]);
      expect(new Headers(calls[0].init.headers).get("X-Ahood-Usage")).toBe("view");
    });

    it("prints the stats line and your vote when present", async () => {
      stubApi(200, { ...base, stats: { views: 120, reads: 40, downloads: 33, stars: 5, upvotes: 12, downvotes: 3 }, my_vote: 1 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await view(["alice/demo"]);
      const out = lastLog(log);
      expect(out).toContain("views 120 · reads 40 · installs 33 · stars 5 · ▲12 ▼3");
      expect(out).toMatch(/your vote:\s+up/);
    });

    it("says down for -1, and prints nothing extra for null or an older server", async () => {
      stubApi(200, { ...base, stats: { views: 1, reads: 0, downloads: 0, stars: 0, upvotes: 0, downvotes: 1 }, my_vote: -1 });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await view(["alice/demo"]);
      expect(lastLog(log)).toMatch(/your vote:\s+down/);

      log.mockClear();
      stubApi(200, { ...base, stats: { views: 1, reads: 0, downloads: 0, stars: 0, upvotes: 0, downvotes: 0 }, my_vote: null });
      await view(["alice/demo"]);
      expect(lastLog(log)).toContain("views 1");
      expect(lastLog(log)).not.toContain("your vote");

      log.mockClear();
      stubApi(200, base);
      await view(["alice/demo"]);
      expect(lastLog(log)).not.toContain("views ");
      expect(lastLog(log)).not.toContain("your vote");
    });

    it("--json passes stats and my_vote through untouched", async () => {
      const body = { ...base, stats: { views: 9, reads: 8, downloads: 7, stars: 6, upvotes: 5, downvotes: 4 }, my_vote: -1 };
      stubApi(200, body);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await view(["alice/demo", "--json"]);
      expect(JSON.parse(lastLog(log))).toEqual(body);
    });
  });

  describe("read", () => {
    const detail = { owner: "alice", slug: "demo", name: "Demo", skill_versions: { version: "1.0.0", skill_md_content: "# demo\n" } };

    it("sends X-Ahood-Usage: read", async () => {
      const calls = stubApi(200, detail);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await read(["alice/demo"]);
      expect(new Headers(calls[0].init.headers).get("X-Ahood-Usage")).toBe("read");
    });

    it("prints the rate hint on a TTY only, never with --json", async () => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});

      stubApi(200, detail);
      await read(["alice/demo"]); // piped
      expect(err).not.toHaveBeenCalled();

      process.stdout.isTTY = true;
      stubApi(200, detail);
      await read(["alice/demo", "--json"]);
      expect(err).not.toHaveBeenCalled();

      stubApi(200, detail);
      await read(["alice/demo"]);
      expect(lastLog(err)).toContain("Rate it after use: ahood skill vote alice/demo up|down");
    });
  });

  describe("printRateHint", () => {
    it("is silent when stdout is not a TTY and dim on a TTY, plain with NO_COLOR", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      printRateHint("agent", "bob", "rev");
      expect(err).not.toHaveBeenCalled();

      process.stdout.isTTY = true;
      const noColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;
      try {
        printRateHint("agent", "bob", "rev");
        expect(err.mock.calls[0][0]).toBe("\x1b[2mRate it after use: ahood agent vote bob/rev up|down\x1b[0m");
        process.env.NO_COLOR = "1";
        printRateHint("agent", "bob", "rev");
        expect(err.mock.calls[1][0]).toBe("Rate it after use: ahood agent vote bob/rev up|down");
      } finally {
        if (noColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColor;
      }
    });
  });
});
