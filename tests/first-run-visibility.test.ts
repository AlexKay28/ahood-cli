// ahood#1612 (UX audit): the no-account search fallback link, and publish's
// create-time visibility choice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/confirm.js")>()),
  confirmYesNo: vi.fn(async () => false),
  isInteractive: vi.fn(() => false),
}));
const confirmMod = await import("../src/confirm.js");
const confirmYesNo = vi.mocked(confirmMod.confirmYesNo);
const isInteractive = vi.mocked(confirmMod.isInteractive);

const { find } = await import("../src/commands/find.js");
const { search } = await import("../src/commands/search.js");
const { publish } = await import("../src/commands/publish.js");
const { ApiError } = await import("../src/http.js");
const { exitCodeFor } = await import("../src/exit-code.js");

const API_URL = "http://ahood.test";
const originalEnv = { api: process.env.AHOOD_API_URL, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, token: process.env.AHOOD_TOKEN };
let home: string;

function isolate() {
  home = mkdtempSync(join(tmpdir(), "ahood-1612-"));
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.AHOOD_TOKEN;
  process.env.AHOOD_API_URL = API_URL;
}
function restore() {
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of [["AHOOD_API_URL", originalEnv.api], ["HOME", originalEnv.home], ["XDG_CONFIG_HOME", originalEnv.xdg], ["AHOOD_TOKEN", originalEnv.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("search without an account (ahood#1612)", () => {
  beforeEach(() => {
    isolate();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restore();
  });

  it("find prints the account message plus the web search URL, exit 4", async () => {
    const err = await find(["postgres tips"]).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/needs a free ahood account/);
    expect(err.message).toContain(`${API_URL}/browse/search?q=postgres%20tips`);
    expect(exitCodeFor(err)).toBe(4);
  });

  it("skill search gets the same link", async () => {
    const err = await search(["postgres"]).catch((e) => e);
    expect(err.message).toContain(`${API_URL}/browse/search?q=postgres`);
  });

  it("--json keeps the plain error: no web URL, still exit 4", async () => {
    const err = await find(["postgres", "--json"]).catch((e) => e);
    expect(err.message).toMatch(/needs a free ahood account/);
    expect(err.message).not.toContain("/browse/search");
    expect(exitCodeFor(err)).toBe(4);
  });

  it("a rejected AHOOD_TOKEN gets no web link (that user has an account)", async () => {
    process.env.AHOOD_TOKEN = "ahd_x";
    const err = await find(["postgres"]).catch((e) => e);
    expect(err.message).toBe("AHOOD_TOKEN was rejected (expired or revoked).");
  });
});

describe("publish visibility (ahood#1612)", () => {
  let dir: string;
  let patches: unknown[];
  let createBody: Record<string, unknown> | undefined;
  let out: string[];

  function stub(opts: { exists: boolean }) {
    let initCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith("/versions/init")) {
          initCalls++;
          if (!opts.exists && initCalls === 1) return new Response("{}", { status: 404 });
          return new Response(JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }), { status: 200 });
        }
        if (url.endsWith("/api/v1/skills")) {
          createBody = JSON.parse(init.body as string);
          return new Response(JSON.stringify({ id: "s1", slug: "demo", owner: "alice" }), { status: 200 });
        }
        if (url === "http://upload.test/put") return new Response(null, { status: 200 });
        if (url.endsWith("/versions/complete")) return new Response(JSON.stringify({ version_id: "v1", version: "1.0.0", status: "processing" }), { status: 202 });
        if (init.method === "PATCH") {
          patches.push(JSON.parse(init.body as string));
          return new Response(JSON.stringify({ slug: "demo", tagline: null }), { status: 200 });
        }
        if (/\/versions\/[^/]+$/.test(url)) return new Response(JSON.stringify({ version: "1.0.0", status: "published" }), { status: 200 });
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );
  }

  beforeEach(() => {
    isolate();
    dir = mkdtempSync(join(tmpdir(), "ahood-1612-pub-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\n# demo");
    patches = [];
    createBody = undefined;
    out = [];
    confirmYesNo.mockReset().mockResolvedValue(false);
    isInteractive.mockReset().mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    restore();
  });

  const ARGS = ["alice/demo@1.0.0", "--path", "", "--name", "Demo"];
  const args = (...extra: string[]) => ARGS.map((a) => (a === "" ? dir : a)).concat(extra);

  it("interactive yes: creates, then makes it public", async () => {
    stub({ exists: false });
    isInteractive.mockReturnValue(true);
    confirmYesNo.mockResolvedValue(true);
    await publish(args());
    expect(confirmYesNo).toHaveBeenCalledWith("Make alice/demo public so others can find and install it? [y/N] ");
    expect(patches).toEqual([{ visibility: "public" }]);
    expect(createBody).not.toHaveProperty("visibility");
    expect(out.join("\n")).toContain("alice/demo is public.");
  });

  it("interactive no: stays private and prints the exact edit command", async () => {
    stub({ exists: false });
    isInteractive.mockReturnValue(true);
    await publish(args());
    expect(patches).toEqual([]);
    expect(out.join("\n")).toContain("ahood skill edit alice/demo --visibility public");
  });

  it("non-TTY: no prompt, private, hint printed", async () => {
    stub({ exists: false });
    await publish(args());
    expect(confirmYesNo).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(out.join("\n")).toContain("ahood skill edit alice/demo --visibility public");
  });

  it("--visibility public skips the prompt even on a TTY", async () => {
    stub({ exists: false });
    isInteractive.mockReturnValue(true);
    await publish(args("--visibility", "public"));
    expect(confirmYesNo).not.toHaveBeenCalled();
    expect(patches).toEqual([{ visibility: "public" }]);
  });

  it("--visibility private skips the prompt and prints no hint", async () => {
    stub({ exists: false });
    isInteractive.mockReturnValue(true);
    await publish(args("--visibility=private"));
    expect(confirmYesNo).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(out.join("\n")).not.toContain("--visibility public");
  });

  it("--json never prompts and keeps stdout to one JSON object", async () => {
    stub({ exists: false });
    isInteractive.mockReturnValue(true);
    await publish(args("--json"));
    expect(confirmYesNo).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0])).not.toThrow();
  });

  it("rejects an invalid --visibility before any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(publish(args("--visibility", "secret"))).rejects.toThrow(/--visibility must be "public" or "private"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a new version of an existing artifact never prompts or hints", async () => {
    stub({ exists: true });
    isInteractive.mockReturnValue(true);
    await publish(args());
    expect(confirmYesNo).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
    expect(out.join("\n")).not.toContain("--visibility public");
  });
});
