import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { versions } from "../src/commands/versions.js";
import { ApiError } from "../src/http.js";

const API_URL = "http://ahood.test";

describe("versions", () => {
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
    await expect(versions([])).rejects.toThrow(/Usage: ahood versions/);
  });

  it("rejects a malformed spec via the shared validator", async () => {
    await expect(versions(["alice/.."])).rejects.toThrow(/Invalid skill/);
  });

  it("rejects a spec missing a skill segment via the shared validator, with no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(versions(["alice"])).rejects.toThrow(/Usage: ahood versions/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hits the /versions endpoint for the given owner/skill", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ versions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo"]);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_URL}/api/v1/skills/alice/demo/versions`,
      expect.anything(),
    );
  });

  it("--json prints the raw versions array", async () => {
    const list = [
      { version: "1.1.0", changelog_md: "Fixed a bug", package_size_bytes: 12697, status: "published", created_at: "2026-02-01T00:00:00Z" },
      { version: "1.0.0", changelog_md: null, package_size_bytes: 10035, status: "published", created_at: "2026-01-01T00:00:00Z" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ versions: list }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(list));
  });

  it("prints a human-readable listing with version, publish date, human-readable size, and changelog", async () => {
    const list = [
      { version: "1.1.0", changelog_md: "Fixed a bug", package_size_bytes: 12697, status: "published", created_at: "2026-02-01T00:00:00Z" },
      { version: "1.0.0", changelog_md: null, package_size_bytes: 10035, status: "published", created_at: "2026-01-01T00:00:00Z" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ versions: list }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("alice/demo");
    expect(output).toContain("1.1.0");
    expect(output).toContain("1.0.0");
    expect(output).toContain("2026-02-01T00:00:00Z");
    expect(output).toContain("2026-01-01T00:00:00Z");
    expect(output).toContain("12.4 KB");
    expect(output).toContain("9.8 KB");
    expect(output).toContain("Fixed a bug");
    // Absent changelog falls back to "-" rather than printing null.
    expect(output).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("--json passes yanked_at/yanked_reason through verbatim when present", async () => {
    const list = [
      {
        version: "1.1.0",
        changelog_md: "Fixed a bug",
        package_size_bytes: 12697,
        status: "published",
        created_at: "2026-02-01T00:00:00Z",
        yanked_at: "2026-08-31T00:00:00.000Z",
        yanked_reason: "typo in SKILL.md",
      },
      { version: "1.0.0", changelog_md: null, package_size_bytes: 10035, status: "published", created_at: "2026-01-01T00:00:00Z", yanked_at: null, yanked_reason: null },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ versions: list }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(list));
  });

  it("marks a yanked version clearly in human output, with its reason, while a non-yanked version's output is unchanged", async () => {
    const list = [
      {
        version: "1.1.0",
        changelog_md: "Fixed a bug",
        package_size_bytes: 12697,
        status: "published",
        created_at: "2026-02-01T00:00:00Z",
        yanked_at: "2026-08-31T00:00:00.000Z",
        yanked_reason: "typo in SKILL.md",
      },
      { version: "1.0.0", changelog_md: null, package_size_bytes: 10035, status: "published", created_at: "2026-01-01T00:00:00Z", yanked_at: null, yanked_reason: null },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ versions: list }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo"]);

    const calls = logSpy.mock.calls.map((c) => c[0]);
    const output = calls.join("\n");
    expect(output).toContain("YANKED");
    expect(output).toContain("typo in SKILL.md");

    // The yanked version's block includes a status line; the non-yanked
    // version's block does not gain one.
    const v110Index = calls.indexOf("1.1.0");
    const v100Index = calls.indexOf("1.0.0");
    expect(calls[v110Index + 4]).toContain("status:");
    expect(calls[v110Index + 4]).toContain("YANKED -- typo in SKILL.md");
    // 1.0.0 is the last entry -- its block ends at the changelog line, with
    // no trailing status line and no more output after it.
    expect(calls.length).toBe(v100Index + 4);
  });

  it("marks a yanked version with no reason as plain YANKED, without a trailing '-- '", async () => {
    const list = [
      {
        version: "2.0.0",
        changelog_md: null,
        package_size_bytes: 1024,
        status: "published",
        created_at: "2026-03-01T00:00:00Z",
        yanked_at: "2026-08-31T00:00:00.000Z",
        yanked_reason: null,
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ versions: list }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toMatch(/status:\s+YANKED\s*$/m);
    expect(output).not.toContain("YANKED --");
  });

  it("reports a skill with no published versions instead of printing an empty table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ versions: [] }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await versions(["alice/demo"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("no published versions");
  });

  it("propagates a 404 for an unknown owner/skill", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 })));

    await expect(versions(["ghost/nope"])).rejects.toThrow(ApiError);
    await expect(versions(["ghost/nope"])).rejects.toMatchObject({ status: 404 });
  });
});
