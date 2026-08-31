import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { view } from "../src/commands/view.js";

const API_URL = "http://ahood.test";

describe("view", () => {
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

  it("rejects with a usage error when no spec is given", async () => {
    await expect(view([])).rejects.toThrow(/Usage: ahood view/);
  });

  it("rejects a malformed spec via the shared validator", async () => {
    await expect(view(["alice/.."])).rejects.toThrow(/Invalid skill/);
  });

  // ahood-cli#38: a validly-charset-formatted but pathologically long segment
  // used to sail past parseOwnerSkill and reach the network, where a truly
  // huge (e.g. 10,000-char) path can hit a raw infra/CDN-layer 502 instead of
  // a clean client-side error. Assert no fetch happens at all.
  it("rejects an oversized owner/skill spec client-side with no network call (ahood-cli#38)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(view([`alexkay/${"a".repeat(10_000)}`])).rejects.toThrow(/too long/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("--json prints the raw skill object", async () => {
    const detail = {
      slug: "demo",
      name: "Demo",
      tagline: "a demo",
      visibility: "public",
      downloads_count: 3,
      stars_count: 1,
      skill_versions: { version: "1.0.0", checksum_sha256: "abc" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await view(["alice/demo", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(detail));
  });

  it("prints tags, license, homepage, repository, and dates in the default (non-JSON) output", async () => {
    const detail = {
      slug: "demo",
      name: "Demo",
      tagline: "a demo",
      license: "MIT",
      visibility: "public",
      tags: ["cli", "productivity"],
      homepage: "https://example.com",
      repository: "https://github.com/alice/demo",
      downloads_count: 3,
      stars_count: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      owner: "alice",
      is_starred: true,
      skill_versions: { version: "1.0.0", checksum_sha256: "abc" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await view(["alice/demo"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("alice/demo");
    expect(output).toContain("cli, productivity");
    expect(output).toContain("MIT");
    expect(output).toContain("https://example.com");
    expect(output).toContain("https://github.com/alice/demo");
    expect(output).toContain("2026-01-01T00:00:00Z");
    expect(output).toContain("2026-01-02T00:00:00Z");
    expect(output).toContain("yes");
  });

  it("falls back to '-' for absent optional fields instead of printing null/undefined", async () => {
    const detail = {
      slug: "demo",
      name: "Demo",
      tagline: null,
      license: null,
      visibility: "private",
      tags: [],
      homepage: null,
      repository: null,
      downloads_count: 0,
      stars_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      owner: "alice",
      is_starred: null,
      skill_versions: null,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await view(["alice/demo"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("no published version");
    expect(output).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});
