import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { add, extractTarGz } from "../src/commands/add.js";
import { agentPath, skillDir, MCP_CONFIG_PATH } from "../src/spec.js";

vi.mock("../src/secret-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/secret-prompt.js")>();
  return { ...actual, promptSecret: vi.fn(async () => "prompted-secret-value") };
});
import { promptSecret } from "../src/secret-prompt.js";

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
  kind?: "skill" | "agent" | "mcp",
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
    // Cleared here (not just per-test) so a `.not.toHaveBeenCalled()`
    // assertion in one test can't spuriously fail because an EARLIER test
    // already called the same module-level mock -- vi.mock's factory
    // creates promptSecret's vi.fn() once for the whole file, and nothing
    // else resets its call history between tests.
    vi.mocked(promptSecret).mockClear();
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

  it("installs an mcp artifact (remote) by merging an entry into .mcp.json", async () => {
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    await add([`${OWNER}/${SKILL}`]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL]).toEqual({ url: "https://mcp.example.com/sse" });
  });

  it("installs an mcp artifact (npm package) mapping registry_type/runtime_hint to command/args", async () => {
    const serverJson = JSON.stringify({
      name: "weather-server",
      description: "d",
      packages: [
        { registry_type: "npm", identifier: "@example/weather-mcp-server", version: "1.4.0", runtime_hint: "npx" },
      ],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    await add([`${OWNER}/${SKILL}`]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL]).toEqual({
      command: "npx",
      args: ["-y", "@example/weather-mcp-server@1.4.0"],
    });
  });

  it("uses an already-set environment variable for a secret without prompting", async () => {
    const serverJson = JSON.stringify({
      name: "weather-server",
      description: "d",
      packages: [
        {
          registry_type: "npm",
          identifier: "@example/weather-mcp-server",
          version: "1.4.0",
          runtime_hint: "npx",
          environment_variables: [
            { name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true },
          ],
        },
      ],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");
    process.env.WEATHER_API_KEY = "already-set-value";

    try {
      await add([`${OWNER}/${SKILL}`]);
    } finally {
      delete process.env.WEATHER_API_KEY;
    }

    expect(promptSecret).not.toHaveBeenCalled();
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL].env).toEqual({ WEATHER_API_KEY: "already-set-value" });
  });

  it("prompts for a secret env var that is not already set", async () => {
    const serverJson = JSON.stringify({
      name: "weather-server",
      description: "d",
      packages: [
        {
          registry_type: "npm",
          identifier: "@example/weather-mcp-server",
          version: "1.4.0",
          runtime_hint: "npx",
          environment_variables: [
            { name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true },
          ],
        },
      ],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");
    delete process.env.WEATHER_API_KEY;

    await add([`${OWNER}/${SKILL}`]);

    expect(promptSecret).toHaveBeenCalledWith(expect.stringContaining("WEATHER_API_KEY"));
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL].env).toEqual({ WEATHER_API_KEY: "prompted-secret-value" });
  });

  it("refuses to install and does not write .mcp.json when the entry name already exists", async () => {
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    const existing = { mcpServers: { [SKILL]: { url: "https://already-here.test" } } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/already has an entry/);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL]).toEqual({ url: "https://already-here.test" });
  });

  it("redacts secret values from the conflicting .mcp.json entry echoed in the collision error message", async () => {
    // The plaintext value here ("super-secret-value") must never appear in
    // the thrown error's message -- update.ts calls add() for every locked
    // entry and prints caught error messages, so a leak here would print a
    // previously-installed server's API key to stderr on every
    // `ahood skill update` run.
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    const existing = {
      mcpServers: {
        [SKILL]: {
          command: "npx",
          args: ["-y", "@example/weather-mcp-server@1.4.0"],
          env: { WEATHER_API_KEY: "super-secret-value" },
        },
      },
    };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    let error: Error | undefined;
    try {
      await add([`${OWNER}/${SKILL}`]);
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toMatch(/already has an entry/);
    expect(error?.message).not.toContain("super-secret-value");
    // The key is still visible (so the user can tell WHAT'S conflicting) --
    // only the value is redacted.
    expect(error?.message).toContain("WEATHER_API_KEY");
  });

  it("does not leak a secret embedded in the conflicting entry's args or url in the collision error (finding #1)", async () => {
    // Unlike env/headers keys, a hand-authored .mcp.json entry routinely
    // passes a credential as a CLI arg or in a URL query string -- neither
    // of which the old 2-key ("env"/"headers") redaction allowlist ever
    // touched. This is the entry being COLLIDED with, not one ahood wrote.
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    const existing = {
      mcpServers: {
        [SKILL]: {
          command: "npx",
          args: ["-y", "@thing/mcp", "--api-key", "sk-live-topsecret123"],
        },
      },
    };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    let error: Error | undefined;
    try {
      await add([`${OWNER}/${SKILL}`]);
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toMatch(/already has an entry/);
    expect(error?.message).not.toContain("sk-live-topsecret123");
  });

  it("does not leak a secret embedded in a conflicting entry's URL query string in the collision error (finding #1)", async () => {
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    const existing = {
      mcpServers: {
        [SKILL]: { url: "https://host.example.com/sse?token=topsecretquerytoken" },
      },
    };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    let error: Error | undefined;
    try {
      await add([`${OWNER}/${SKILL}`]);
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toMatch(/already has an entry/);
    expect(error?.message).not.toContain("topsecretquerytoken");
  });

  it("still redacts secret values from env/headers keys, but shows key names (unchanged behavior)", async () => {
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    const existing = {
      mcpServers: {
        [SKILL]: {
          command: "npx",
          args: ["-y", "@example/weather-mcp-server@1.4.0"],
          env: { WEATHER_API_KEY: "super-secret-value" },
        },
      },
    };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    let error: Error | undefined;
    try {
      await add([`${OWNER}/${SKILL}`]);
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toMatch(/already has an entry/);
    expect(error?.message).not.toContain("super-secret-value");
    expect(error?.message).toContain("WEATHER_API_KEY");
  });

  it("strips control characters from manifest-derived text before it reaches the secret prompt (finding #4)", async () => {
    // A malicious/compromised server.json's description or name is
    // server-validated only as a string -- a terminal control sequence
    // embedded in it (cursor movement, line clear) must never reach the
    // terminal verbatim right before a masked credential prompt.
    const maliciousDescription = "API key\x1b[2K\x1b[1G\x1b[31mFAKE PROMPT: enter password: \x1b[0m";
    const serverJson = JSON.stringify({
      name: "weather-server",
      description: "d",
      packages: [
        {
          registry_type: "npm",
          identifier: "@example/weather-mcp-server",
          version: "1.4.0",
          runtime_hint: "npx",
          environment_variables: [
            { name: "WEATHER_API_KEY", description: maliciousDescription, is_required: true, is_secret: true },
          ],
        },
      ],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");
    delete process.env.WEATHER_API_KEY;

    await add([`${OWNER}/${SKILL}`]);

    const promptCalls = vi.mocked(promptSecret).mock.calls.map((c) => c[0]);
    expect(promptCalls.some((p) => p.includes("\x1b"))).toBe(false);
  });

  it("strips control characters from manifest.name before it reaches an error message (finding #4)", async () => {
    const maliciousName = "evil\x1b[2Kserver";
    const serverJson = JSON.stringify({
      name: maliciousName,
      description: "d",
      packages: [{ registry_type: "pypi", identifier: "x", version: "1.0.0", runtime_hint: "uvx" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    let error: Error | undefined;
    try {
      await add([`${OWNER}/${SKILL}`]);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toBeDefined();
    expect(error!.message).not.toContain("\x1b");
  });

  it("prompts for a secret when the env var is set to an empty string, matching resolveToken's precedent (finding #6)", async () => {
    const serverJson = JSON.stringify({
      name: "weather-server",
      description: "d",
      packages: [
        {
          registry_type: "npm",
          identifier: "@example/weather-mcp-server",
          version: "1.4.0",
          runtime_hint: "npx",
          environment_variables: [
            { name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true },
          ],
        },
      ],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");
    process.env.WEATHER_API_KEY = "";

    try {
      await add([`${OWNER}/${SKILL}`]);
    } finally {
      delete process.env.WEATHER_API_KEY;
    }

    expect(promptSecret).toHaveBeenCalledWith(expect.stringContaining("WEATHER_API_KEY"));
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL].env).toEqual({ WEATHER_API_KEY: "prompted-secret-value" });
  });

  it("refuses to install when .mcp.json's mcpServers is not a JSON object (e.g. an array)", async () => {
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: [] }, null, 2));

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/mcpServers/);

    // Must not silently "succeed" while writing nothing -- the file must be
    // left exactly as it was, not mutated into some half-written state.
    expect(JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"))).toEqual({ mcpServers: [] });
  });

  it("checks for an existing .mcp.json collision before prompting for any secret", async () => {
    const serverJson = JSON.stringify({
      name: "weather-server",
      description: "d",
      packages: [
        {
          registry_type: "npm",
          identifier: "@example/weather-mcp-server",
          version: "1.4.0",
          runtime_hint: "npx",
          environment_variables: [
            { name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true },
          ],
        },
      ],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");
    delete process.env.WEATHER_API_KEY;

    const existing = { mcpServers: { [SKILL]: { url: "https://already-here.test" } } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/already has an entry/);

    // The user must not have been made to type a secret at a masked prompt
    // for an install that was refused anyway.
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it("does not leave a temp file or lock directory behind after installing an mcp artifact", async () => {
    const serverJson = JSON.stringify({
      name: "hosted-search",
      description: "d",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    await add([`${OWNER}/${SKILL}`]);

    const entries = readdirSync(dir);
    expect(entries.some((f) => f.startsWith(".mcp.json.tmp-"))).toBe(false);
    expect(entries.some((f) => f === ".mcp.json.lock")).toBe(false);
  });

  it("preserves other existing mcpServers entries and top-level keys when merging", async () => {
    const serverJson = JSON.stringify({ name: "hosted-search", description: "d", remotes: [{ url: "https://mcp.example.com/sse" }] });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    const existing = { someOtherTopLevelKey: true, mcpServers: { "unrelated-server": { url: "https://other.test" } } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify(existing, null, 2));

    await add([`${OWNER}/${SKILL}`]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.someOtherTopLevelKey).toBe(true);
    expect(mcpConfig.mcpServers["unrelated-server"]).toEqual({ url: "https://other.test" });
    expect(mcpConfig.mcpServers[SKILL]).toEqual({ url: "https://mcp.example.com/sse" });
  });

  it("does not print the scripts/ warning for an mcp install, even if the manifest lists a scripts/ path", async () => {
    const serverJson = JSON.stringify({ name: "hosted-search", description: "d", remotes: [{ url: "https://mcp.example.com/sse" }] });
    const archive = await tarGz({ "server.json": serverJson });
    stubApi(archive, sha256(archive), [{ path: "server.json" }, { path: "scripts/run.sh" }], VERSION, "mcp");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await add([`${OWNER}/${SKILL}`]);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("scripts/"));
    warnSpy.mockRestore();
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
