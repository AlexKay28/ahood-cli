import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

// ahood-cli#258: a failed UPGRADE used to delete the working previous version
// and leave the lockfile pinning something no longer on disk. Same
// pass-through lockfile mock as tests/add-mcp-rollback.test.ts (see the
// comment there for why it has to be a module-level replacement), kept in its
// own file so the fresh-install cases there stay about fresh installs.
const hooks = vi.hoisted(() => ({
  onWriteLockfileEntry: null as null | (() => void),
}));

vi.mock("../src/lockfile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lockfile.js")>();
  return {
    ...actual,
    writeLockfileEntryVerifyingChecksum: (path: string, key: string, entry: import("../src/lockfile.js").LockEntry) => {
      hooks.onWriteLockfileEntry?.();
      return actual.writeLockfileEntryVerifyingChecksum(path, key, entry);
    },
  };
});

import { add } from "../src/commands/add.js";
import { update } from "../src/commands/update.js";
import { currentHostIdentity, readLockfile } from "../src/lockfile.js";
import { agentPath, skillDir, LOCKFILE_PATH, SKILLS_ROOT } from "../src/spec.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";

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

type Published = { version: string; files: Record<string, string>; kind?: "agent" };

// Serves each slug's ONE current version as "latest", the way the registry
// does after a publish; calling it again is the publish.
async function publish(entries: Record<string, Published>): Promise<void> {
  const served = new Map<string, { body: string; archive: Buffer }>();
  for (const [slug, entry] of Object.entries(entries)) {
    const archive = await tarGz(entry.files);
    const checksum = createHash("sha256").update(archive).digest("hex");
    const manifest = Object.keys(entry.files).map((path) => ({ path }));
    served.set(`${API_URL}/api/v1/skills/${OWNER}/${slug}`, {
      body: JSON.stringify({
        skill_versions: { version: entry.version, manifest, checksum_sha256: checksum },
        ...(entry.kind ? { kind: entry.kind } : {}),
      }),
      archive,
    });
    served.set(`${API_URL}/api/v1/skills/${OWNER}/${slug}/download?version=${entry.version}`, { body: "", archive });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const hit = served.get(url);
      if (!hit) return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
      if (url.includes("/download?")) return new Response(new Uint8Array(hit.archive), { status: 200 });
      return new Response(hit.body, { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const SKILL_V1: Published = { version: "1.0.0", files: { "SKILL.md": "# skill v1\n", "only-in-v1.md": "v1\n" } };
const SKILL_V2: Published = { version: "2.0.0", files: { "SKILL.md": "# skill v2\n", "only-in-v2.md": "v2\n" } };
const AGENT_V1: Published = { version: "1.0.0", files: { "AGENT.md": "# agent v1\n" }, kind: "agent" };
const AGENT_V2: Published = { version: "2.0.0", files: { "AGENT.md": "# agent v2\n" }, kind: "agent" };

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (!child.pid) throw new Error("could not spawn a throwaway process");
  return child.pid;
}

describe("a failed update keeps the previous version (ahood-cli#258)", () => {
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    hooks.onWriteLockfileEntry = null;
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-update-rollback-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    process.exitCode = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    hooks.onWriteLockfileEntry = null;
    vi.unstubAllGlobals();
    process.exitCode = 0;
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  const pin = (slug: string) => readLockfile(join(dir, LOCKFILE_PATH))[`${OWNER}/${slug}`];
  const skillFile = (slug: string, name: string) => join(dir, skillDir(OWNER, slug), name);
  // Everything directly under .claude/skills/ -- what Claude Code's loader
  // would walk -- so a leftover staging or set-aside directory shows up here.
  const skillsRootEntries = () => (existsSync(join(dir, SKILLS_ROOT)) ? readdirSync(join(dir, SKILLS_ROOT)).sort() : []);

  function failLockfileWrite(): Error {
    const boom = new Error("EACCES: permission denied, open '.claude/skills.lock.json'");
    hooks.onWriteLockfileEntry = () => {
      throw boom;
    };
    return boom;
  }

  it("restores the v1 skill directory and leaves the v1 pin when the lockfile write fails", async () => {
    await publish({ skill1: SKILL_V1 });
    await add([`${OWNER}/skill1`]);
    await publish({ skill1: SKILL_V2 });
    const boom = failLockfileWrite();

    await expect(add([`${OWNER}/skill1`])).rejects.toBe(boom);

    expect(readFileSync(skillFile("skill1", "SKILL.md"), "utf-8")).toContain("# skill v1");
    expect(existsSync(skillFile("skill1", "only-in-v1.md"))).toBe(true);
    expect(existsSync(skillFile("skill1", "only-in-v2.md"))).toBe(false);
    expect(pin("skill1")?.version).toBe("1.0.0");
    expect(skillsRootEntries()).toEqual([`${OWNER}@skill1`]);
  });

  it("restores the v1 agent file and leaves the v1 pin when the lockfile write fails", async () => {
    await publish({ agent1: AGENT_V1 });
    await add([`${OWNER}/agent1`]);
    const v1Bytes = readFileSync(join(dir, agentPath(OWNER, "agent1")));
    await publish({ agent1: AGENT_V2 });
    const boom = failLockfileWrite();

    await expect(add([`${OWNER}/agent1`])).rejects.toBe(boom);

    expect(readFileSync(join(dir, agentPath(OWNER, "agent1"))).equals(v1Bytes)).toBe(true);
    expect(pin("agent1")?.version).toBe("1.0.0");
  });

  // The issue's own reproduction, end to end through `update` and the real
  // lock: nothing is hooked, the lockfile's lock is simply held by a live
  // process (this one) for longer than withLock's 5s timeout.
  it("keeps both a skill and an agent when `update` times out on a held lockfile lock", { timeout: 30_000 }, async () => {
    await publish({ skill1: SKILL_V1, agent1: AGENT_V1 });
    await add([`${OWNER}/skill1`]);
    await add([`${OWNER}/agent1`]);
    await publish({ skill1: SKILL_V2, agent1: AGENT_V2 });
    const lockDir = join(dir, `${LOCKFILE_PATH}.lock`);
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(process.pid));
    writeFileSync(join(lockDir, "host"), currentHostIdentity());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await update([]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/Timed out waiting for the lock/);
    rmSync(lockDir, { recursive: true, force: true });
    expect(readFileSync(skillFile("skill1", "SKILL.md"), "utf-8")).toContain("# skill v1");
    expect(existsSync(skillFile("skill1", "only-in-v1.md"))).toBe(true);
    expect(readFileSync(join(dir, agentPath(OWNER, "agent1")), "utf-8")).toContain("# agent v1");
    expect(pin("skill1")?.version).toBe("1.0.0");
    expect(pin("agent1")?.version).toBe("1.0.0");
    expect(skillsRootEntries()).toEqual([`${OWNER}@skill1`]);
  });

  it("still swaps in the new version on success and leaves no set-aside copy of the old one", async () => {
    await publish({ skill1: SKILL_V1 });
    await add([`${OWNER}/skill1`]);
    await publish({ skill1: SKILL_V2 });

    await add([`${OWNER}/skill1`]);

    expect(readFileSync(skillFile("skill1", "SKILL.md"), "utf-8")).toContain("# skill v2");
    expect(existsSync(skillFile("skill1", "only-in-v2.md"))).toBe(true);
    // A file dropped in v2 must not survive the upgrade (the reason the
    // directory is swapped rather than extracted over).
    expect(existsSync(skillFile("skill1", "only-in-v1.md"))).toBe(false);
    expect(pin("skill1")?.version).toBe("2.0.0");
    expect(skillsRootEntries()).toEqual([`${OWNER}@skill1`]);
  });

  it("still leaves nothing behind when a FRESH skill install fails", async () => {
    await publish({ skill1: SKILL_V1 });
    const boom = failLockfileWrite();

    await expect(add([`${OWNER}/skill1`])).rejects.toBe(boom);

    expect(skillsRootEntries()).toEqual([]);
    expect(pin("skill1")).toBeUndefined();
  });

  it("still leaves nothing behind when a FRESH agent install fails", async () => {
    await publish({ agent1: AGENT_V1 });
    const boom = failLockfileWrite();

    await expect(add([`${OWNER}/agent1`])).rejects.toBe(boom);

    expect(existsSync(join(dir, agentPath(OWNER, "agent1")))).toBe(false);
    expect(pin("agent1")).toBeUndefined();
  });

  describe("a swap interrupted by a kill", () => {
    // What a run killed between its two renames leaves: the previous version
    // set aside in its holder, nothing at the skill's own path.
    function strandPreviousVersion(pid: number): string {
      const holder = join(dir, SKILLS_ROOT, `.${OWNER}@skill1.swap-${pid}-1700000000000`);
      mkdirSync(holder, { recursive: true });
      rmSync(join(holder, "old"), { recursive: true, force: true });
      mkdirSync(join(holder, "old"));
      for (const name of readdirSync(join(dir, skillDir(OWNER, "skill1")))) {
        writeFileSync(join(holder, "old", name), readFileSync(skillFile("skill1", name)));
      }
      rmSync(join(dir, skillDir(OWNER, "skill1")), { recursive: true, force: true });
      return holder;
    }

    it("puts the stranded previous version back before installing, so a failure still restores it", async () => {
      await publish({ skill1: SKILL_V1 });
      await add([`${OWNER}/skill1`]);
      strandPreviousVersion(deadPid());
      await publish({ skill1: SKILL_V2 });
      const boom = failLockfileWrite();

      await expect(add([`${OWNER}/skill1`])).rejects.toBe(boom);

      expect(readFileSync(skillFile("skill1", "SKILL.md"), "utf-8")).toContain("# skill v1");
      expect(pin("skill1")?.version).toBe("1.0.0");
      expect(skillsRootEntries()).toEqual([`${OWNER}@skill1`]);
    });

    it("collects a dead run's leftover holder on the next successful install", async () => {
      await publish({ skill1: SKILL_V1 });
      await add([`${OWNER}/skill1`]);
      const holder = join(dir, SKILLS_ROOT, `.${OWNER}@skill1.swap-${deadPid()}-1700000000000`);
      mkdirSync(join(holder, "new"), { recursive: true });
      writeFileSync(join(holder, "new", "SKILL.md"), "# half-staged\n");
      await publish({ skill1: SKILL_V2 });

      await add([`${OWNER}/skill1`]);

      expect(readFileSync(skillFile("skill1", "SKILL.md"), "utf-8")).toContain("# skill v2");
      expect(skillsRootEntries()).toEqual([`${OWNER}@skill1`]);
    });

    it("leaves a holder alone while the run that owns it is still alive, and one that only looks like ours", async () => {
      await publish({ skill1: SKILL_V1 });
      await add([`${OWNER}/skill1`]);
      // This process's own pid stands in for a concurrent ahood mid-swap.
      const live = `.${OWNER}@skill1.swap-${process.pid}-1700000000000`;
      const lookalike = `.${OWNER}@skill1.swap-notes`;
      mkdirSync(join(dir, SKILLS_ROOT, live, "old"), { recursive: true });
      mkdirSync(join(dir, SKILLS_ROOT, lookalike));
      await publish({ skill1: SKILL_V2 });

      await add([`${OWNER}/skill1`]);

      expect(skillsRootEntries()).toEqual([live, lookalike, `${OWNER}@skill1`].sort());
    });
  });
});
