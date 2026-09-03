import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remove } from "../src/commands/remove.js";
import { writeLockfileEntry, readLockfile } from "../src/lockfile.js";
import { agentPath } from "../src/spec.js";

describe("remove", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-remove-test-"));
    process.chdir(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects with a usage error when no spec is given", async () => {
    await expect(remove([])).rejects.toThrow(/Usage: ahood remove/);
  });

  it("removes the installed skill directory and its lockfile entry", async () => {
    mkdirSync(join(dir, ".claude", "skills", "alice", "demo"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "alice", "demo", "SKILL.md"), "# demo");
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/demo", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    await remove(["alice/demo"]);

    expect(existsSync(join(dir, ".claude", "skills", "alice", "demo"))).toBe(false);
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toEqual({});
  });

  it("sweeps the now-empty owner directory but not a sibling skill's", async () => {
    mkdirSync(join(dir, ".claude", "skills", "alice", "demo"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "alice", "other"), { recursive: true });

    await remove(["alice/demo"]);

    expect(existsSync(join(dir, ".claude", "skills", "alice", "demo"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills", "alice", "other"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "skills", "alice"))).toBe(true);
  });

  it("reports failure instead of a false 'Removed' when nothing was installed", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await remove(["nobody/nothing"]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/was not installed/));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("removes an installed agent file and its lockfile entry", async () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    const dest = join(dir, agentPath("alice", "reviewer"));
    writeFileSync(dest, "# reviewer agent\n");
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/reviewer", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    await remove(["alice/reviewer"]);

    expect(existsSync(dest)).toBe(false);
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toEqual({});
  });

  it("still reports 'not installed' for a nonexistent agent (doesn't false-positive on the new agent check)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await remove(["nobody/no-such-agent"]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/was not installed/));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("rejects a spec that tries to traverse outside .claude/skills/ via '..'", async () => {
    mkdirSync(join(dir, ".claude", "skills", "alice", "demo"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "bob", "other"), { recursive: true });
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "outside", "important.txt"), "keep me");

    await expect(remove(["alice/.."])).rejects.toThrow(/Invalid skill/);
    // The whole skills tree (every owner) must still be intact.
    expect(existsSync(join(dir, ".claude", "skills", "alice", "demo"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "skills", "bob", "other"))).toBe(true);

    await expect(remove(["../outside"])).rejects.toThrow(/Invalid owner/);
    expect(existsSync(join(dir, "outside", "important.txt"))).toBe(true);
  });
});
