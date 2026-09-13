import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

// Lives in its own file because these tests need a NON-conflict failure out
// of writeLockfileEntryVerifyingChecksum (and, for the rollback-fails case, a
// failing withLock) -- neither of which any real fixture can produce on
// demand, and node:fs-style named imports can't be vi.spyOn'd in ESM, only
// replaced at the module level. The replacement is the same pass-through
// shape tests/lockfile-atomic.test.ts uses: every export stays the real one
// (LockfileChecksumConflictError included, so `instanceof` in add.ts still
// holds) and the two hooked functions only diverge when a test installs a
// hook. Kept out of tests/add.test.ts so that suite's ~60 other cases keep
// running against the real lockfile module.
const hooks = vi.hoisted(() => ({
  onWriteLockfileEntry: null as null | (() => void),
  onWithLock: null as null | ((path: string) => void),
}));

vi.mock("../src/lockfile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lockfile.js")>();
  return {
    ...actual,
    writeLockfileEntryVerifyingChecksum: (path: string, key: string, entry: import("../src/lockfile.js").LockEntry) => {
      hooks.onWriteLockfileEntry?.();
      return actual.writeLockfileEntryVerifyingChecksum(path, key, entry);
    },
    withLock: (<T>(path: string, fn: () => T): T => {
      hooks.onWithLock?.(path);
      return actual.withLock(path, fn);
    }) as typeof actual.withLock,
  };
});

vi.mock("../src/secret-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/secret-prompt.js")>();
  // Literal rather than the SECRET const below: a vi.mock factory is hoisted
  // above this file's top-level bindings.
  return { ...actual, promptSecret: vi.fn(async () => "sk-live-rollback-secret") };
});

import { add } from "../src/commands/add.js";
import { readLockfile, writeLockfileEntry } from "../src/lockfile.js";
import { agentPath, skillDir, LOCKFILE_PATH, MCP_CONFIG_PATH } from "../src/spec.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "weather";
const VERSION = "1.0.0";
const SECRET = "sk-live-rollback-secret";

const MANIFEST = JSON.stringify({
  name: "weather",
  description: "weather server",
  packages: [
    {
      registry_type: "npm",
      identifier: "@example/weather-mcp-server",
      version: "1.4.0",
      runtime_hint: "npx",
      environment_variables: [{ name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true }],
    },
  ],
});

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

function stubApi(archive: Buffer, checksum: string, onDownload?: () => void) {
  stubApiKind(archive, checksum, "mcp", [{ path: "server.json" }], onDownload);
}

function stubApiKind(
  archive: Buffer,
  checksum: string,
  kind: "skill" | "agent" | "mcp" | undefined,
  manifest: Array<{ path: string }>,
  onDownload?: () => void,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
        return new Response(
          JSON.stringify({
            skill_versions: { version: VERSION, manifest, checksum_sha256: checksum },
            ...(kind ? { kind } : {}),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=${VERSION}`) {
        onDownload?.();
        return new Response(new Uint8Array(archive), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
    }),
  );
}

describe("installMcpEntry rollback (ahood-cli#132)", () => {
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;
  let warnings: string[];

  beforeEach(() => {
    hooks.onWriteLockfileEntry = null;
    hooks.onWithLock = null;
    warnings = [];
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-mcp-rollback-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    vi.spyOn(console, "warn").mockImplementation((msg) => void warnings.push(String(msg)));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    hooks.onWriteLockfileEntry = null;
    hooks.onWithLock = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  function mcpServers(): Record<string, unknown> {
    const contents = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    return (contents.mcpServers ?? {}) as Record<string, unknown>;
  }

  // The bug itself: anything but a checksum conflict -- a withLock timeout
  // against a concurrent ahood, an EACCES/ENOSPC -- used to rethrow before
  // the rollback, stranding the just-merged entry AND the secret in it with
  // no lockfile pin, which `remove` then refuses to clean up.
  it("rolls back the .mcp.json entry when the lockfile write fails for a reason other than a checksum conflict", async () => {
    const archive = await tarGz({ "server.json": MANIFEST });
    stubApi(archive, sha256(archive));
    const boom = new Error("EACCES: permission denied, open '.claude/skills.lock.json'");
    hooks.onWriteLockfileEntry = () => {
      throw boom;
    };

    // The original error must reach the caller unchanged -- same instance,
    // not remapped into the checksum-conflict message.
    await expect(add([`${OWNER}/${SKILL}`])).rejects.toBe(boom);

    expect(mcpServers()).toEqual({});
    expect(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8")).not.toContain(SECRET);
    expect(readLockfile(join(dir, LOCKFILE_PATH))[`${OWNER}/${SKILL}`]).toBeUndefined();
  });

  // Rollback failure must not become the error the user sees: it is the
  // less actionable of the two, and on the conflict path it would replace
  // the checksum-conflict message outright.
  it("surfaces the original error and warns about the stranded entry when the rollback itself fails", async () => {
    const archive = await tarGz({ "server.json": MANIFEST });
    stubApi(archive, sha256(archive));
    const boom = new Error("EACCES: permission denied, open '.claude/skills.lock.json'");
    hooks.onWriteLockfileEntry = () => {
      throw boom;
    };
    // Call 1 is installMcpEntry's own merge into .mcp.json; call 2 is the
    // rollback -- fail only that one, the way a still-contended lock would.
    let mcpLocks = 0;
    hooks.onWithLock = (path) => {
      if (path !== MCP_CONFIG_PATH) return;
      mcpLocks++;
      if (mcpLocks === 2) throw new Error("Timed out waiting for lock on .mcp.json");
    };

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toBe(boom);

    expect(mcpLocks).toBe(2); // the rollback was actually attempted
    const warning = warnings.find((line) => line.includes("could not roll back"));
    expect(warning).toBeDefined();
    // It has to name the entry precisely enough to be deleted by hand --
    // nothing else is going to tell the user the secret is sitting there.
    expect(warning).toContain(MCP_CONFIG_PATH);
    expect(warning).toContain(`"${SKILL}"`);
    expect(warning).toContain(`${OWNER}/${SKILL}`);
    // ...because it really is still there.
    expect(mcpServers()[SKILL]).toBeDefined();
  });

  // Regression for the branch that already worked: driven by a real
  // LockfileChecksumConflictError from the real lockfile code (a concurrent
  // writer landing during the download, as in tests/add.test.ts's #101
  // case), not by a hook.
  it("still rolls back and still reports the checksum conflict when the lockfile write conflicts", async () => {
    const archive = await tarGz({ "server.json": MANIFEST });
    stubApi(archive, sha256(archive), () => {
      writeLockfileEntry(join(dir, LOCKFILE_PATH), `${OWNER}/${SKILL}`, {
        version: VERSION,
        checksum_sha256: "concurrent-writer-won",
      });
    });

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/does not match the one already pinned/);

    expect(mcpServers()).toEqual({});
    expect(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8")).not.toContain(SECRET);
    // The concurrent writer's pin survives untouched.
    expect(readLockfile(join(dir, LOCKFILE_PATH))[`${OWNER}/${SKILL}`]).toEqual({
      version: VERSION,
      checksum_sha256: "concurrent-writer-won",
    });
  });

  // The skill and agent write paths carried the same narrow guard. A
  // leftover there is far less dangerous than a stranded secret (no
  // credential, and `remove` finds it via dirExisted/agentExisted even with
  // no pin), but they were widened alongside the mcp path so that "a failed
  // install installs nothing" holds at all three -- and so the next reader
  // doesn't have to work out which of three near-identical blocks was the
  // one that mattered.
  it("rolls back an extracted skill directory when the lockfile write fails for a reason other than a checksum conflict", async () => {
    const archive = await tarGz({ "SKILL.md": "# demo\n" });
    stubApiKind(archive, sha256(archive), undefined, [{ path: "SKILL.md" }]);
    const boom = new Error("ENOSPC: no space left on device");
    hooks.onWriteLockfileEntry = () => {
      throw boom;
    };

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toBe(boom);

    expect(existsSync(join(dir, skillDir(OWNER, SKILL)))).toBe(false);
  });

  it("rolls back a written agent file when the lockfile write fails for a reason other than a checksum conflict", async () => {
    const archive = await tarGz({ "AGENT.md": "# agent\n" });
    stubApiKind(archive, sha256(archive), "agent", [{ path: "AGENT.md" }]);
    const boom = new Error("ENOSPC: no space left on device");
    hooks.onWriteLockfileEntry = () => {
      throw boom;
    };

    await expect(add([`${OWNER}/${SKILL}`])).rejects.toBe(boom);

    expect(existsSync(join(dir, agentPath(OWNER, SKILL)))).toBe(false);
  });

  it("leaves no .mcp.json entry behind and reports the conflict even when the rollback fails", async () => {
    const archive = await tarGz({ "server.json": MANIFEST });
    stubApi(archive, sha256(archive), () => {
      writeLockfileEntry(join(dir, LOCKFILE_PATH), `${OWNER}/${SKILL}`, {
        version: VERSION,
        checksum_sha256: "concurrent-writer-won",
      });
    });
    let mcpLocks = 0;
    hooks.onWithLock = (path) => {
      if (path !== MCP_CONFIG_PATH) return;
      mcpLocks++;
      if (mcpLocks === 2) throw new Error("Timed out waiting for lock on .mcp.json");
    };

    // The conflict message, not the lock timeout, is what the user needs.
    await expect(add([`${OWNER}/${SKILL}`])).rejects.toThrow(/does not match the one already pinned/);
    expect(warnings.some((line) => line.includes("could not roll back"))).toBe(true);
    expect(existsSync(join(dir, MCP_CONFIG_PATH))).toBe(true);
  });
});
