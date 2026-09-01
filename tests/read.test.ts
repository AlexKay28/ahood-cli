import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { read } from "../src/commands/read.js";

const API_URL = "http://ahood.test";

describe("read", () => {
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
    await expect(read([])).rejects.toThrow(/Usage: ahood skill read/);
  });

  it("rejects a malformed spec via the shared validator", async () => {
    await expect(read(["alice/.."])).rejects.toThrow(/Invalid skill/);
  });

  it("prints the raw SKILL.md content verbatim in plain mode", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: { version: "1.0.0", skill_md_content: "# Demo Skill\n\nDo the thing." },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await read(["alice/demo"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("# Demo Skill\n\nDo the thing.");
  });

  it("--json emits {version, content} as a single line", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: { version: "1.2.3", skill_md_content: "# Demo Skill\n" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await read(["alice/demo", "--json"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ version: "1.2.3", content: "# Demo Skill\n" }));
  });

  it("warns when the latest version has been yanked, with the reason appended, before printing content", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: {
        version: "1.0.0",
        skill_md_content: "# Demo Skill\n",
        yanked_at: "2026-01-03T00:00:00Z",
        yanked_reason: "contains a critical bug",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await read(["alice/demo"]);

    expect(warnSpy).toHaveBeenCalledWith(
      "WARNING: alice/demo@1.0.0 has been yanked: contains a critical bug",
    );
    expect(logSpy).toHaveBeenCalledWith("# Demo Skill\n");
    // Warning must fire before the content is printed.
    const warnOrder = warnSpy.mock.invocationCallOrder[0];
    const logOrder = logSpy.mock.invocationCallOrder[0];
    expect(warnOrder).toBeLessThan(logOrder);
  });

  it("warns without a reason suffix when yanked_reason is absent", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: {
        version: "1.0.0",
        skill_md_content: "# Demo Skill\n",
        yanked_at: "2026-01-03T00:00:00Z",
        yanked_reason: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await read(["alice/demo"]);

    expect(warnSpy).toHaveBeenCalledWith("WARNING: alice/demo@1.0.0 has been yanked.");
  });

  it("does not warn for a non-yanked version", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: { version: "1.0.0", skill_md_content: "# Demo Skill\n" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await read(["alice/demo"]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws a clear error when there is no published version", async () => {
    const detail = { owner: "alice", slug: "demo", skill_versions: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(read(["alice/demo"])).rejects.toThrow(/alice\/demo has no published version/);
  });

  it("throws a clear error when skill_md_content is null", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: { version: "1.0.0", skill_md_content: null },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(read(["alice/demo"])).rejects.toThrow(/no SKILL\.md content available/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("throws a clear error when skill_md_content is an empty string", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: { version: "1.0.0", skill_md_content: "" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));

    await expect(read(["alice/demo"])).rejects.toThrow(/no SKILL\.md content available/);
  });

  it("propagates a fetch/API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })),
    );

    await expect(read(["alice/demo"])).rejects.toThrow(/not found/);
  });
});
