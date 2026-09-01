import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { unpublish } from "../src/commands/unpublish.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "demo-skill";

function stubApi(status: number, body: unknown = { deleted: true }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

// unpublish() reads a confirmation line from stdin via
// node:readline/promises -- feed it one directly instead of touching the
// real terminal, and capture what gets written to stdout as the prompt.
function stubStdio(answer: string): { promptedWith(): string } {
  const written: string[] = [];
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
  const fakeStdout = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream & { fd: 1 };
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(fakeStdout);
  queueMicrotask(() => {
    fakeStdin.push(`${answer}\n`);
    fakeStdin.push(null);
  });
  return { promptedWith: () => written.join("") };
}

describe("unpublish", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("rejects with a usage error when no owner/skill is given", async () => {
    await expect(unpublish([])).rejects.toThrow(/Usage: ahood unpublish/);
  });

  it("does not call the API when the user does not type exactly 'yes'", async () => {
    const calls = stubApi(200);
    stubStdio("y");

    await unpublish([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(0);
  });

  it("calls DELETE on the skill once the user confirms with 'yes'", async () => {
    const calls = stubApi(200);
    const stdio = stubStdio("yes");

    await unpublish([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);
    expect(calls[0].init.method).toBe("DELETE");
    expect(stdio.promptedWith()).toMatch(/permanently delete/);
  });

  it("is case-insensitive on the confirmation ('YES' still confirms)", async () => {
    const calls = stubApi(200);
    stubStdio("YES");

    await unpublish([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(1);
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(404, { error: "Not found" });
    stubStdio("yes");

    await expect(unpublish([`${OWNER}/${SKILL}`])).rejects.toThrow(/Not found/);
  });

  it("rejects instead of silently exiting success when stdin closes with no answer at all", async () => {
    const calls = stubApi(200);
    const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
    vi.spyOn(process, "stdout", "get").mockReturnValue(
      new Writable({ write(_c, _e, cb) { cb(); } }) as unknown as NodeJS.WriteStream & { fd: 1 },
    );
    queueMicrotask(() => fakeStdin.push(null)); // EOF, no data at all

    await expect(unpublish([`${OWNER}/${SKILL}`])).rejects.toThrow(/not answered/);
    expect(calls).toHaveLength(0);
  });

  it("--yes bypasses the prompt entirely, for scripted/CI use", async () => {
    const calls = stubApi(200);

    await unpublish([`${OWNER}/${SKILL}`, "--yes"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("DELETE");
  });

  describe("with an @version suffix", () => {
    const VERSION = "1.2.3";
    const SPEC = `${OWNER}/${SKILL}@${VERSION}`;

    it("calls DELETE on the specific version (not the whole-skill DELETE) once confirmed", async () => {
      const calls = stubApi(200, { yanked_at: "2026-08-31T00:00:00.000Z" });
      const stdio = stubStdio("yes");

      await unpublish([SPEC]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}`);
      expect(calls[0].init.method).toBe("DELETE");
      expect(stdio.promptedWith()).toMatch(/Yank/);
      expect(stdio.promptedWith()).not.toMatch(/permanently delete/);
    });

    it("does not call the API when the user does not type exactly 'yes'", async () => {
      const calls = stubApi(200);
      stubStdio("y");

      await unpublish([SPEC]);

      expect(calls).toHaveLength(0);
    });

    it("--yes bypasses the prompt entirely, for scripted/CI use", async () => {
      const calls = stubApi(200);

      await unpublish([SPEC, "--yes"]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}`);
      expect(calls[0].init.method).toBe("DELETE");
    });

    it("surfaces the server's error message on a non-2xx response", async () => {
      stubApi(400, { error: "Version 1.2.3 is already yanked" });
      stubStdio("yes");

      await expect(unpublish([SPEC])).rejects.toThrow(/already yanked/);
    });

    it("rejects an invalid version format before making any API call", async () => {
      const calls = stubApi(200);

      await expect(unpublish([`${OWNER}/${SKILL}@not-a-version`, "--yes"])).rejects.toThrow(/Invalid version/);

      expect(calls).toHaveLength(0);
    });

    it("does not perform any resolution lookup for an explicit @version -- only the DELETE is called", async () => {
      const calls = stubApi(200);

      await unpublish([SPEC, "--yes"]);

      expect(calls).toHaveLength(1);
      expect(calls[0].init.method).toBe("DELETE");
    });
  });

  // ahood-cli#62: "ahood unpublish owner/skill@latest --yes" (and the
  // equivalent bare "owner/skill@latest") used to send the literal string
  // "latest" straight through to DELETE .../versions/{version}, which does
  // an exact match against skill_versions.version -- there's no "latest" row
  // there, so it always 404'd with a generic "Not found", even though
  // "latest" is exactly what someone reaches for right after a bad publish.
  describe("with an @latest suffix (ahood-cli#62)", () => {
    const REAL_VERSION = "2.4.0";
    const SPEC = `${OWNER}/${SKILL}@latest`;

    // Mirrors add.ts's fetchVersionMeta resolution path: GET
    // /api/v1/skills/{owner}/{skill} returns a `skill_versions` field joined
    // against the skill's latest_version_id, giving the real version string.
    function stubApiWithLatestResolution(versionResponses: {
      metaStatus?: number;
      metaBody?: unknown;
      deleteStatus?: number;
      deleteBody?: unknown;
    }) {
      const { metaStatus = 200, metaBody = { skill_versions: { version: REAL_VERSION } }, deleteStatus = 200, deleteBody = { yanked_at: "2026-08-31T00:00:00.000Z" } } =
        versionResponses;
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input);
          calls.push({ url, init });
          if (!init.method || init.method === "GET") {
            return new Response(JSON.stringify(metaBody), {
              status: metaStatus,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(deleteBody), {
            status: deleteStatus,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      return calls;
    }

    it("resolves @latest to the real latest version and sends the DELETE for that resolved version, not the literal 'latest'", async () => {
      const calls = stubApiWithLatestResolution({});

      await unpublish([SPEC, "--yes"]);

      expect(calls).toHaveLength(2);
      // Resolution lookup: GET .../skills/{owner}/{skill} (no "latest" literal
      // anywhere in this URL).
      expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);
      expect(calls[0].init.method === "GET" || calls[0].init.method === undefined).toBe(true);
      // Yank request: the resolved real version, never the literal "latest".
      expect(calls[1].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${REAL_VERSION}`);
      expect(calls[1].url).not.toContain("/versions/latest");
      expect(calls[1].init.method).toBe("DELETE");
    });

    it("resolves @latest before prompting, so the confirmation shows the real version instead of the word 'latest'", async () => {
      stubApiWithLatestResolution({});
      const stdio = stubStdio("yes");

      await unpublish([SPEC]);

      expect(stdio.promptedWith()).toContain(`${OWNER}/${SKILL}@${REAL_VERSION}`);
      expect(stdio.promptedWith()).not.toContain("@latest");
    });

    it("surfaces a clear error, not a confusing 'Not found', when the skill has no published versions at all", async () => {
      stubApiWithLatestResolution({ metaBody: { skill_versions: null } });

      await expect(unpublish([SPEC, "--yes"])).rejects.toThrow(/has no published version/);
    });
  });

  it("still performs the whole-skill DELETE when the spec has no @version", async () => {
    const calls = stubApi(200);

    await unpublish([`${OWNER}/${SKILL}`, "--yes"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);
    expect(calls[0].init.method).toBe("DELETE");
  });
});
