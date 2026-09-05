import { describe, expect, it, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { diff } from "../src/commands/diff.js";
import { ApiError } from "../src/http.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "demo-skill";

// Same in-memory gzipped-tar fixture builder as tests/add.test.ts -- reused
// verbatim rather than reinvented, per the resolution plan for issue #88.
function tarGz(files: Record<string, string>): Promise<Buffer> {
  const tar = pack();
  for (const [name, content] of Object.entries(files)) {
    tar.entry({ name }, content);
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolvePromise, reject) => {
    tar.on("data", (chunk) => chunks.push(chunk as Buffer));
    tar.on("end", () => resolvePromise(gzipSync(Buffer.concat(chunks))));
    tar.on("error", reject);
  });
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

type Manifest = Array<{ path: string }>;

// Serves the four requests `diff` makes for two explicit versions: a
// versions/<version> metadata fetch and a download for each side. No
// "latest" resolution here since diff requires two explicit semvers.
function stubApi(
  versionsData: Record<string, { archive: Buffer; manifest: Manifest } | "missing">,
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      for (const [version, data] of Object.entries(versionsData)) {
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${version}`) {
          if (data === "missing") {
            return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
          }
          return new Response(
            JSON.stringify({
              version,
              manifest: data.manifest,
              checksum_sha256: sha256(data.archive),
              yanked_at: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (data !== "missing" && url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=${version}`) {
          return new Response(new Uint8Array(data.archive), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
    }),
  );
  return calls;
}

describe("diff", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects with a usage error when arguments are missing", async () => {
    await expect(diff([])).rejects.toThrow(/Usage: ahood skill diff/);
    await expect(diff([`${OWNER}/${SKILL}`])).rejects.toThrow(/Usage: ahood skill diff/);
    await expect(diff([`${OWNER}/${SKILL}`, "1.0.0"])).rejects.toThrow(/Usage: ahood skill diff/);
  });

  it("rejects a malformed owner/skill spec via the shared validator, with no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(diff(["alice/..", "1.0.0", "1.1.0"])).rejects.toThrow(/Invalid skill/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-semver version, with no network call", async () => {
    process.env.AHOOD_API_URL = API_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(diff([`${OWNER}/${SKILL}`, "latest", "1.1.0"])).rejects.toThrow(/Invalid version/);
    await expect(diff([`${OWNER}/${SKILL}`, "1.0.0", "not-a-version"])).rejects.toThrow(/Invalid version/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("produces a unified SKILL.md diff and reports added/removed files for two differing versions", async () => {
    process.env.AHOOD_API_URL = API_URL;
    const archiveA = await tarGz({ "SKILL.md": "# demo v1\nold line\n", "shared.md": "same\n", "removed.md": "bye\n" });
    const archiveB = await tarGz({ "SKILL.md": "# demo v1\nnew line\n", "shared.md": "same\n", "added.md": "hi\n" });
    stubApi({
      "1.0.0": { archive: archiveA, manifest: [{ path: "SKILL.md" }, { path: "shared.md" }, { path: "removed.md" }] },
      "2.0.0": { archive: archiveB, manifest: [{ path: "SKILL.md" }, { path: "shared.md" }, { path: "added.md" }] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await diff([`${OWNER}/${SKILL}`, "1.0.0", "2.0.0"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain(`${OWNER}/${SKILL}: 1.0.0 -> 2.0.0`);
    expect(output).toContain("-old line");
    expect(output).toContain("+new line");
    expect(output).toContain("Files added: added.md");
    expect(output).toContain("Files removed: removed.md");
  });

  it("--json emits skillmd_diff and the manifest added/removed/changed summary", async () => {
    process.env.AHOOD_API_URL = API_URL;
    const archiveA = await tarGz({ "SKILL.md": "# v1\n" });
    const archiveB = await tarGz({ "SKILL.md": "# v2\n" });
    stubApi({
      "1.0.0": { archive: archiveA, manifest: [{ path: "SKILL.md" }] },
      "1.1.0": { archive: archiveB, manifest: [{ path: "SKILL.md" }] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await diff([`${OWNER}/${SKILL}`, "1.0.0", "1.1.0", "--json"]);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed.skillmd_diff).toContain("-# v1");
    expect(parsed.skillmd_diff).toContain("+# v2");
    expect(parsed.manifest).toEqual({ added: [], removed: [], changed: ["SKILL.md"] });
  });

  it("reports no diff for identical versions, with a sensible plain-mode message and empty JSON diff", async () => {
    process.env.AHOOD_API_URL = API_URL;
    const archive = await tarGz({ "SKILL.md": "# same content\n" });
    stubApi({
      "1.0.0": { archive, manifest: [{ path: "SKILL.md" }] },
      "1.0.1": { archive, manifest: [{ path: "SKILL.md" }] },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await diff([`${OWNER}/${SKILL}`, "1.0.0", "1.0.1"]);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("SKILL.md is unchanged between these versions.");
    expect(output).not.toContain("Files added:");
    expect(output).not.toContain("Files removed:");
    expect(output).not.toContain("Files changed:");

    logSpy.mockClear();
    await diff([`${OWNER}/${SKILL}`, "1.0.0", "1.0.1", "--json"]);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(parsed).toEqual({ skillmd_diff: "", manifest: { added: [], removed: [], changed: [] } });
  });

  it("surfaces a clean error (not a crash) when a requested version does not exist", async () => {
    process.env.AHOOD_API_URL = API_URL;
    const archive = await tarGz({ "SKILL.md": "# v1\n" });
    stubApi({
      "1.0.0": { archive, manifest: [{ path: "SKILL.md" }] },
      "9.9.9": "missing",
    });

    await expect(diff([`${OWNER}/${SKILL}`, "1.0.0", "9.9.9"])).rejects.toThrow(ApiError);
    await expect(diff([`${OWNER}/${SKILL}`, "1.0.0", "9.9.9"])).rejects.toMatchObject({ status: 404 });
  });

  it("errors cleanly when a version's manifest has no SKILL.md", async () => {
    process.env.AHOOD_API_URL = API_URL;
    const archiveA = await tarGz({ "SKILL.md": "# v1\n" });
    const archiveB = await tarGz({ "other.md": "no skill.md here\n" });
    stubApi({
      "1.0.0": { archive: archiveA, manifest: [{ path: "SKILL.md" }] },
      "2.0.0": { archive: archiveB, manifest: [{ path: "other.md" }] },
    });

    await expect(diff([`${OWNER}/${SKILL}`, "1.0.0", "2.0.0"])).rejects.toThrow(/has no SKILL\.md/);
  });
});
