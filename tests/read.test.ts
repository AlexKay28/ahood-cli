import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { read } from "../src/commands/read.js";

const API_URL = "http://ahood.test";

describe("read", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  // process.stdout.isTTY is a plain data property Node sets at startup (absent
  // when stdout is a pipe, which is how vitest runs), not a getter, so these
  // tests assign it directly. It must be restored unconditionally: a leaked
  // `true` would silently change what every other test in this file expects on
  // stdout, and --sequence.shuffle would make that failure intermittent.
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    // Pin the default to the piped path rather than inheriting whatever the
    // runner happens to hand the worker: `read` now branches on this, so every
    // assertion about exact stdout bytes below would otherwise depend on how
    // vitest was invoked. Tests that want the terminal path opt in explicitly.
    process.stdout.isTTY = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.stdout.isTTY = originalIsTTY;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects with a usage error when no spec is given", async () => {
    await expect(read([])).rejects.toThrow(/Usage: ahood skill read/);
  });

  it("rejects a malformed spec via the shared validator", async () => {
    await expect(read(["alice/.."])).rejects.toThrow(/Invalid skill/);
  });

  it("prints the raw SKILL.md content verbatim in plain mode, with no extra trailing newline (#90)", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      // Ends in "\n", like a real, well-formed SKILL.md file -- console.log
      // would append a SECOND one here, which is exactly the bug this test
      // pins.
      skill_versions: { version: "1.0.0", skill_md_content: "# Demo Skill\n\nDo the thing.\n" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await read(["alice/demo"]);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith("# Demo Skill\n\nDo the thing.\n");
  });

  // ahood-cli#133. `skill read` is the command the CLI advertises for
  // inspecting a skill BEFORE installing it, and skill_md_content is
  // publisher-controlled free text, so a hostile SKILL.md reaches the exact
  // user who was trying to be careful.
  describe("terminal escape sequences in publisher-controlled content", () => {
    const HOSTILE = "# Demo Skill\n\x1b]52;c;AAAA\x07\nVerified safe.\n";

    const stubDetail = (skillMdContent: string) => {
      const detail = {
        owner: "alice",
        slug: "demo",
        skill_versions: { version: "1.0.0", skill_md_content: skillMdContent },
      };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    };

    it("strips the OSC 52 clipboard-write sequence when stdout is a terminal", async () => {
      process.stdout.isTTY = true;
      stubDetail(HOSTILE);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await read(["alice/demo"]);

      const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      // The specific payload must not survive, but assert the general property
      // too: no C0/C1 control character other than the layout ones may reach a
      // terminal, so a variant sequence (OSC 0 retitle, ESC[2J screen-clear,
      // ESC(0 charset switch) can't slip through a payload-shaped assertion.
      expect(written).not.toContain("\x1b");
      expect(written).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
      expect(written).toBe("# Demo Skill\n ]52;c;AAAA \nVerified safe.\n");
    });

    it("keeps the document readable on a terminal: newlines and tabs survive, only controls go", async () => {
      process.stdout.isTTY = true;
      stubDetail("# Title\n\n- one\n-\ttwo\n");
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await read(["alice/demo"]);

      // Flattening newlines the way sanitizeForTerminal does for short
      // interpolated fields (ahood-cli#127) would turn a whole SKILL.md into
      // one unreadable line, which is why read uses the document sanitizer.
      expect(writeSpy).toHaveBeenCalledWith("# Title\n\n- one\n-\ttwo\n");
    });

    it("does not truncate a long document on a terminal", async () => {
      process.stdout.isTTY = true;
      const long = `${"x".repeat(5000)}\n`;
      stubDetail(long);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await read(["alice/demo"]);

      // Capping would let a publisher hide the part worth hiding past the cap
      // and have the CLI do the concealing -- see terminal-safe.ts.
      expect(writeSpy).toHaveBeenCalledWith(long);
    });

    it("leaves the piped path byte-identical, escapes and all, so redirection still round-trips (#90)", async () => {
      process.stdout.isTTY = false;
      stubDetail(HOSTILE);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await read(["alice/demo"]);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith(HOSTILE);
    });

    it("sanitizes a yanked_reason carrying an escape sequence", async () => {
      const detail = {
        owner: "alice",
        slug: "demo",
        skill_versions: {
          version: "1.0.0",
          skill_md_content: "# Demo Skill\n",
          yanked_at: "2026-01-03T00:00:00Z",
          yanked_reason: "oops\x1b[2K\x1b[1Gsafe to install",
        },
      };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await read(["alice/demo"]);

      expect(warnSpy).toHaveBeenCalledWith(
        "WARNING: alice/demo@1.0.0 has been yanked: oops [2K [1Gsafe to install",
      );
    });
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
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await read(["alice/demo"]);

    expect(warnSpy).toHaveBeenCalledWith(
      "WARNING: alice/demo@1.0.0 has been yanked: contains a critical bug",
    );
    expect(writeSpy).toHaveBeenCalledWith("# Demo Skill\n");
    // Warning must fire before the content is printed.
    const warnOrder = warnSpy.mock.invocationCallOrder[0];
    const writeOrder = writeSpy.mock.invocationCallOrder[0];
    expect(warnOrder).toBeLessThan(writeOrder);
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
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

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
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await read(["alice/demo"]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws a clear error when there is no published version", async () => {
    const detail = { owner: "alice", slug: "demo", skill_versions: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(read(["alice/demo"])).rejects.toThrow(/alice\/demo has no published version/);
  });

  it("throws a clear error when skill_md_content is null", async () => {
    const detail = {
      owner: "alice",
      slug: "demo",
      skill_versions: { version: "1.0.0", skill_md_content: null },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(read(["alice/demo"])).rejects.toThrow(/no SKILL\.md content available/);
    expect(writeSpy).not.toHaveBeenCalled();
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
