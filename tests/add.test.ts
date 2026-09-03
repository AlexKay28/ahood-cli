import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { add, extractTarGz } from "../src/commands/add.js";
import { agentPath, skillDir } from "../src/spec.js";

const API_URL = "http://ahood.test";
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

// Like tarGz, but takes an ordered list of [name, content] pairs instead of
// a Record -- needed for the duplicate-entry-name test below, which a
// Record's unique keys can't represent.
function tarGzEntries(files: Array<[string, string]>): Promise<Buffer> {
  const tar = pack();
  for (const [name, content] of files) {
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

/**
 * Serves exactly the two requests `add` makes: the skill-detail route it
 * resolves "latest" through, and the download redirect it pulls the archive
 * from. `checksum` is what the SERVER claims -- the whole point of these tests
 * is what happens when that disagrees with the bytes actually delivered.
 */
function stubApi(
  archive: Buffer,
  checksum: string,
  manifest: Array<{ path: string }> = [{ path: "SKILL.md" }],
  version: string = VERSION,
  kind?: "skill" | "agent",
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
        // Real server shape: `kind` is a TOP-LEVEL sibling of `skill_versions`,
        // not nested inside it (GET /api/v1/skills/{owner}/{skill} route.ts) --
        // nesting it here would mask the exact bug this fixture exists to pin.
        return new Response(
          JSON.stringify({
            skill_versions: { version, manifest, checksum_sha256: checksum },
            ...(kind ? { kind } : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${version}`) {
        return new Response(
          JSON.stringify({ version, manifest, checksum_sha256: checksum, yanked_at: null, ...(kind ? { kind } : {}) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=${version}`) {
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
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-add-test-"));
    // `add` writes to the RELATIVE paths .claude/skills/... and
    // .claude/skills.lock.json, which the fs resolves against the real process
    // cwd -- so the scratch directory has to be the cwd, not a mocked
    // process.cwd(). Restored in afterEach.
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
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

  it("rejects a spec whose owner/skill segments try to escape .claude/skills/", async () => {
    await expect(add(["../../etc"])).rejects.toThrow(/Usage: ahood add/);
    await expect(add(["alice/.."])).rejects.toThrow(/Invalid skill/);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("clears the previous version's files on upgrade instead of only adding to them", async () => {
    const v1 = await tarGz({ "SKILL.md": "# v1\n", "old-removed-file.md": "stale\n" });
    stubApi(v1, sha256(v1), [{ path: "SKILL.md" }], "1.0.0");
    await add([`${OWNER}/${SKILL}@1.0.0`]);
    expect(existsSync(join(dir, ".claude", "skills", OWNER, SKILL, "old-removed-file.md"))).toBe(true);

    const v2 = await tarGz({ "SKILL.md": "# v2\n" });
    stubApi(v2, sha256(v2), [{ path: "SKILL.md" }], "2.0.0");
    await add([`${OWNER}/${SKILL}@2.0.0`]);

    expect(readFileSync(join(dir, ".claude", "skills", OWNER, SKILL, "SKILL.md"), "utf-8")).toBe("# v2\n");
    expect(existsSync(join(dir, ".claude", "skills", OWNER, SKILL, "old-removed-file.md"))).toBe(false);
  });

  it("refuses to decompress an archive whose expanded size is over the cap (decompression-bomb guard)", async () => {
    // A highly-compressible payload past the 200 MB decompressed cap --
    // gzip shrinks this to a few KB, so building the fixture is cheap even
    // though the guard it exercises is about the DECOMPRESSED size.
    const bomb = gzipSync(Buffer.alloc(210 * 1024 * 1024));
    await expect(extractTarGz(bomb, join(dir, "out"))).rejects.toThrow(/decompresses to more than/);
  });

  it("refuses to reinstall the same pinned version with a different checksum", async () => {
    const original = await tarGz({ "SKILL.md": "# demo\n" });
    stubApi(original, sha256(original));
    await add([`${OWNER}/${SKILL}`]);

    const tampered = await tarGz({ "SKILL.md": "# tampered\n" });
    stubApi(tampered, sha256(tampered)); // server now claims a different checksum for the SAME version

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/does not match the one already pinned/);
    // Original install must be untouched.
    expect(readFileSync(join(dir, ".claude", "skills", OWNER, SKILL, "SKILL.md"), "utf-8")).toBe("# demo\n");
  });

  it("stops streaming and throws once the running total crosses the download cap, even with no content-length header (#37)", async () => {
    // The header pre-check can't catch this case -- there is no header at
    // all, exactly like a chunked-transfer response or a mutated/redirected
    // presigned storage URL. Only a streaming byte-count check catches it
    // without first buffering the whole body.
    const CHUNK_SIZE = 1024 * 1024; // 1 MB
    const MAX_CHUNKS = 200; // offers up to 200 MB -- 4x the 50 MB cap
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount > MAX_CHUNKS) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK_SIZE));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: VERSION, manifest: [{ path: "SKILL.md" }], checksum_sha256: "0".repeat(64) },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=${VERSION}`) {
          // Deliberately NO content-length header set.
          return new Response(stream, { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
      }),
    );

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/over the 50 MB limit/);

    // The crux of #37: the mock offers up to 200 MB (200 chunks) total. Code
    // that buffers the full body before checking its size (arrayBuffer() then
    // compare) would drain every chunk -- pullCount would land at
    // MAX_CHUNKS + 1 (201). A fix that checks the running total AS bytes
    // arrive stops within a few chunks of crossing the 50 MB cap (~51).
    expect(pullCount).toBeLessThan(60);
  });

  it("installs an agent as a single file at .claude/agents/<owner>@<skill>.md, not a directory", async () => {
    const archive = await tarGz({ "AGENT.md": "# reviewer agent\n" });
    stubApi(archive, sha256(archive), [{ path: "AGENT.md" }], VERSION, "agent");

    await add([`${OWNER}/${SKILL}`]);

    const dest = join(dir, agentPath(OWNER, SKILL));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("# reviewer agent\n");
    // A single flat file, not a directory -- distinct from the skills'
    // owner-nested .claude/skills/<owner>/<skill>/ layout.
    expect(existsSync(join(dir, ".claude", "skills", OWNER, SKILL))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".claude", "skills.lock.json"), "utf-8"))).toEqual({
      [`${OWNER}/${SKILL}`]: { version: VERSION, checksum_sha256: sha256(archive) },
    });
  });

  it("still installs a skill as a directory under .claude/skills/<owner>/<skill>/ (unchanged)", async () => {
    const archive = await tarGz({ "SKILL.md": "# demo\n" });
    stubApi(archive, sha256(archive), [{ path: "SKILL.md" }], VERSION, "skill");

    await add([`${OWNER}/${SKILL}`]);

    expect(readFileSync(join(dir, skillDir(OWNER, SKILL), "SKILL.md"), "utf-8")).toBe("# demo\n");
    expect(existsSync(join(dir, ".claude", "agents"))).toBe(false);
  });

  it("refuses to decompress an agent archive whose expanded size is over the cap (decompression-bomb guard)", async () => {
    // Mirrors the extractTarGz decompression-bomb test above, but exercises
    // the agent-install path (extractSingleFileContent) end-to-end through
    // add(), so a missing maxOutputLength on that call's gunzipSync would
    // allocate unboundedly instead of throwing cleanly.
    const bomb = gzipSync(Buffer.alloc(210 * 1024 * 1024));
    stubApi(bomb, sha256(bomb), [{ path: "AGENT.md" }], VERSION, "agent");

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/decompresses to more than/);
    // Must fail before anything is written to disk.
    expect(existsSync(join(dir, ".claude", "agents"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills.lock.json"))).toBe(false);
  });

  it("installs an agent through the 'latest' resolution path (GET .../skills/{owner}/{skill}), reading kind from the TOP level of the response, not nested inside skill_versions", async () => {
    // Regression test for the finding: the real server returns `kind` as a
    // sibling of `skill_versions`, not nested inside it. stubApi's
    // skill-detail response now matches that real shape (kind top-level) --
    // this pins the fix in fetchVersionMeta's "latest" branch.
    const archive = await tarGz({ "AGENT.md": "# reviewer agent\n" });
    const calls = stubApi(archive, sha256(archive), [{ path: "AGENT.md" }], VERSION, "agent");

    await add([`${OWNER}/${SKILL}`]);

    expect(calls).toContain(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);
    expect(calls).not.toContain(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}`);

    const dest = join(dir, agentPath(OWNER, SKILL));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("# reviewer agent\n");
    expect(existsSync(join(dir, ".claude", "skills", OWNER, SKILL))).toBe(false);
  });

  it("installs an agent through the explicit @version resolution path (GET .../versions/{version}), not just latest", async () => {
    // Every other agent test in this file omits a version, which only
    // exercises fetchVersionMeta's "latest" branch (GET .../skills/{owner}/
    // {skill}). This one pins an explicit version so the OTHER branch (GET
    // .../versions/{version}) is what actually resolves the agent install.
    const archive = await tarGz({ "AGENT.md": "# reviewer agent\n" });
    const calls = stubApi(archive, sha256(archive), [{ path: "AGENT.md" }], VERSION, "agent");

    await add([`${OWNER}/${SKILL}@${VERSION}`]);

    expect(calls).toContain(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/versions/${VERSION}`);
    expect(calls).not.toContain(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);

    const dest = join(dir, agentPath(OWNER, SKILL));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("# reviewer agent\n");
    expect(existsSync(join(dir, ".claude", "skills", OWNER, SKILL))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".claude", "skills.lock.json"), "utf-8"))).toEqual({
      [`${OWNER}/${SKILL}`]: { version: VERSION, checksum_sha256: sha256(archive) },
    });
  });

  it("installs an agent whose AGENT.md tar entry is named './AGENT.md' (a plain `tar czf` commonly adds this prefix)", async () => {
    // Same normalization extractTarGz and the server's normalizeEntryPath
    // already apply -- without it, a "./AGENT.md" entry passes server-side
    // publish/validation fine but fails to install here with "AGENT.md not
    // found in the downloaded archive" (final review finding #3).
    const archive = await tarGz({ "./AGENT.md": "# reviewer agent\n" });
    stubApi(archive, sha256(archive), [{ path: "AGENT.md" }], VERSION, "agent");

    await add([`${OWNER}/${SKILL}`]);

    const dest = join(dir, agentPath(OWNER, SKILL));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("# reviewer agent\n");
  });

  it("uses the FIRST matching entry when an archive has two entries at the same normalized name, matching the server's files.find(...) lookup", async () => {
    const archive = await tarGzEntries([
      ["AGENT.md", "# first\n"],
      ["AGENT.md", "# second\n"],
    ]);
    stubApi(archive, sha256(archive), [{ path: "AGENT.md" }], VERSION, "agent");

    await add([`${OWNER}/${SKILL}`]);

    const dest = join(dir, agentPath(OWNER, SKILL));
    expect(readFileSync(dest, "utf-8")).toBe("# first\n");
  });

  it("does not print the scripts/ warning for an agent install, even if the manifest lists a scripts/ path", async () => {
    // Only AGENT.md's content is ever written for an agent install -- a
    // scripts/ entry in the manifest can't materialize on disk there, so the
    // skill-worded warning is both wrong and pointless here (finding #5).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = await tarGz({ "AGENT.md": "# reviewer agent\n" });
    stubApi(
      archive,
      sha256(archive),
      [{ path: "AGENT.md" }, { path: "scripts/run.sh" }],
      VERSION,
      "agent",
    );

    await add([`${OWNER}/${SKILL}`]);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/scripts\//));
  });

  it("still prints the scripts/ warning for a skill install with a scripts/ path (unchanged)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = await tarGz({ "SKILL.md": "# demo\n", "scripts/run.sh": "echo hi\n" });
    stubApi(
      archive,
      sha256(archive),
      [{ path: "SKILL.md" }, { path: "scripts/run.sh" }],
      VERSION,
      "skill",
    );

    await add([`${OWNER}/${SKILL}`]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/scripts\//));
  });

});
