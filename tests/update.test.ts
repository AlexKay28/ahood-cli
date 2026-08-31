import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
