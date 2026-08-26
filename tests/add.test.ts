import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { add } from "../src/commands/add.js";

const API_URL = "http://skillhub.test";
const OWNER = "alice";
const SKILL = "demo-skill";
const VERSION = "1.0.0";

// A real gzipped tar, built the same way `publish` builds one -- the checksum
// test has to fail on the CHECKSUM, not on an unparseable archive, or it would
// still pass with the checksum check deleted.
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

/**
 * Serves exactly the two requests `add` makes: the skill-detail route it
 * resolves "latest" through, and the download redirect it pulls the archive
 * from. `checksum` is what the SERVER claims -- the whole point of these tests
 * is what happens when that disagrees with the bytes actually delivered.
 */
function stubApi(archive: Buffer, checksum: string, manifest: Array<{ path: string }> = [{ path: "SKILL.md" }]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
        return new Response(
          JSON.stringify({ skill_versions: { version: VERSION, manifest, checksum_sha256: checksum } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=${VERSION}`) {
        return new Response(new Uint8Array(archive), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
    }),
  );
  return calls;
}

describe("add", () => {
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.SKILLHUB_API_URL;
  const originalToken = process.env.SKILLHUB_TOKEN;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "skillhub-add-test-"));
    // `add` writes to the RELATIVE paths .claude/skills/... and
    // .claude/skills.lock.json, which the fs resolves against the real process
    // cwd -- so the scratch directory has to be the cwd, not a mocked
    // process.cwd(). Restored in afterEach.
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.SKILLHUB_API_URL = API_URL;
    delete process.env.SKILLHUB_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.SKILLHUB_API_URL;
    else process.env.SKILLHUB_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.SKILLHUB_TOKEN;
    else process.env.SKILLHUB_TOKEN = originalToken;
  });

  it("refuses to install when the downloaded archive's checksum does not match the server's", async () => {
    const archive = await tarGz({ "SKILL.md": "# demo\n" });
    const wrongChecksum = "0".repeat(64);
    expect(sha256(archive)).not.toBe(wrongChecksum);
    stubApi(archive, wrongChecksum);

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/Checksum mismatch/);
  });

  it("leaves no files behind when the checksum does not match", async () => {
    const archive = await tarGz({ "SKILL.md": "# demo\n" });
    stubApi(archive, "0".repeat(64));

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow();

    // The check must happen BEFORE extraction and before the lockfile write --
    // a refactor that reordered it past either would ship green without these.
    expect(existsSync(join(dir, ".claude", "skills", OWNER, SKILL))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills.lock.json"))).toBe(false);
  });

  it("installs under .claude/skills/<owner>/<skill> and pins the lockfile when the checksum matches", async () => {
    const archive = await tarGz({ "SKILL.md": "# demo\n" });
    stubApi(archive, sha256(archive));

    await add([`${OWNER}/${SKILL}`]);

    // Owner-namespaced: alice/demo-skill and bob/demo-skill must not collide.
    expect(readFileSync(join(dir, ".claude", "skills", OWNER, SKILL, "SKILL.md"), "utf-8")).toBe("# demo\n");
    expect(JSON.parse(readFileSync(join(dir, ".claude", "skills.lock.json"), "utf-8"))).toEqual({
      [`${OWNER}/${SKILL}`]: { version: VERSION, checksum_sha256: sha256(archive) },
    });
  });

  it("refuses an archive whose entry name escapes the destination directory", async () => {
    // Checksum deliberately CORRECT here, so the only thing that can stop this
    // is the path-containment guard in extractTarGz.
    const archive = await tarGz({ "../escaped.txt": "pwned\n" });
    stubApi(archive, sha256(archive), [{ path: "../escaped.txt" }]);

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/unsafe archive entry/);
    expect(existsSync(join(dir, ".claude", "skills", OWNER, "escaped.txt"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills", "escaped.txt"))).toBe(false);
  });
});
