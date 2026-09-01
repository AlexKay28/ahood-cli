import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { update } from "../src/commands/update.js";
import { writeLockfileEntry } from "../src/lockfile.js";

const API_URL = "http://ahood.test";

function tarGz(files: Record<string, string>): Promise<Buffer> {
  const tar = pack();
  for (const [name, content] of Object.entries(files)) tar.entry({ name }, content);
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

describe("update", () => {
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-update-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Without this, console.log/console.error spies from an earlier test in
    // this file are never un-wrapped -- vi.spyOn() on an already-spied method
    // just stacks another layer, so a later test's mock.calls silently
    // includes output from tests that ran before it.
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("reports nothing to do when the lockfile is empty", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await update([]);
    expect(logSpy).toHaveBeenCalledWith("No installed skills to update.");
  });

  it("continues updating remaining skills after one fails, and exits non-zero", async () => {
    const goodArchive = await tarGz({ "SKILL.md": "# good\n" });
    const goodChecksum = sha256(goodArchive);

    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/good", {
      version: "1.0.0",
      checksum_sha256: "old",
    });
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "bob/broken", {
      version: "1.0.0",
      checksum_sha256: "old",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/good`) {
          return new Response(
            JSON.stringify({ skill_versions: { version: "1.1.0", manifest: [{ path: "SKILL.md" }], checksum_sha256: goodChecksum } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/good/download?version=1.1.0`) {
          return new Response(new Uint8Array(goodArchive), { status: 200 });
        }
        if (url === `${API_URL}/api/v1/skills/bob/broken`) {
          return new Response(JSON.stringify({ error: "This skill was unpublished" }), { status: 404 });
        }
        return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await update([]);

    expect(readFileSync(join(dir, ".claude", "skills", "alice", "good", "SKILL.md"), "utf-8")).toBe("# good\n");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bob/broken"));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  describe("--dry-run", () => {
    const lockfilePath = () => join(dir, ".claude", "skills.lock.json");
    const skillDirPath = (owner: string, skill: string) => join(dir, ".claude", "skills", owner, skill);

    function stubResolveOnly(fetchCalls: string[]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          fetchCalls.push(url);
          if (url === `${API_URL}/api/v1/skills/alice/behind`) {
            return new Response(
              JSON.stringify({
                skill_versions: {
                  version: "2.0.0",
                  manifest: [{ path: "SKILL.md" }],
                  checksum_sha256: "new-checksum",
                  changelog_md: "## 2.0.0\n- Breaking change.",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url === `${API_URL}/api/v1/skills/alice/current`) {
            return new Response(
              JSON.stringify({
                skill_versions: {
                  version: "1.0.0",
                  manifest: [{ path: "SKILL.md" }],
                  checksum_sha256: "same-checksum",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // Any download endpoint hit at all means --dry-run failed to stay
          // read-only -- fail loudly instead of serving a fake archive.
          throw new Error(`unexpected fetch during --dry-run: ${url}`);
        }),
      );
    }

    beforeEach(() => {
      writeLockfileEntry(lockfilePath(), "alice/behind", { version: "1.0.0", checksum_sha256: "old-checksum" });
      writeLockfileEntry(lockfilePath(), "alice/current", { version: "1.0.0", checksum_sha256: "same-checksum" });
    });

    it("previews the diff table without installing, downloading, or touching the lockfile", async () => {
      const fetchCalls: string[] = [];
      stubResolveOnly(fetchCalls);
      const lockfileBefore = readFileSync(lockfilePath(), "utf-8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await update(["--dry-run"]);

      // No download endpoint was ever hit.
      expect(fetchCalls.some((u) => u.includes("/download"))).toBe(false);
      // Nothing was extracted to disk.
      expect(existsSync(skillDirPath("alice", "behind"))).toBe(false);
      // The lockfile is byte-for-byte unchanged -- --dry-run never re-pins anything.
      expect(readFileSync(lockfilePath(), "utf-8")).toBe(lockfileBefore);

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("alice/behind");
      expect(output).toContain("1.0.0");
      expect(output).toContain("2.0.0");
      expect(output).toContain("update available");
      expect(output).toContain("Breaking change.");
    });

    it("marks a skill already at latest as up to date, not as needing an update", async () => {
      const fetchCalls: string[] = [];
      stubResolveOnly(fetchCalls);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await update(["alice/current", "--dry-run"]);

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("up to date");
      expect(output).not.toContain("update available");
      expect(output).toContain("All skills are already up to date.");
    });

    it("emits structured, machine-readable output with --json", async () => {
      const fetchCalls: string[] = [];
      stubResolveOnly(fetchCalls);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await update(["--dry-run", "--json"]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(parsed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skill: "alice/behind",
            current_version: "1.0.0",
            latest_version: "2.0.0",
            up_to_date: false,
            changelog_md: "## 2.0.0\n- Breaking change.",
          }),
          expect.objectContaining({
            skill: "alice/current",
            current_version: "1.0.0",
            latest_version: "1.0.0",
            up_to_date: true,
            changelog_md: null,
          }),
        ]),
      );
      expect(fetchCalls.some((u) => u.includes("/download"))).toBe(false);
      expect(existsSync(skillDirPath("alice", "behind"))).toBe(false);
    });
  });
});
