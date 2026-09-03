import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remove } from "../src/commands/remove.js";
import { writeLockfileEntry, readLockfile } from "../src/lockfile.js";
import { agentPath, MCP_CONFIG_PATH } from "../src/spec.js";

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

  it("warns about a live .mcp.json entry left behind by an mcp install, instead of silently reporting success (finding #3)", async () => {
    // remove() has no code path that ever touches skillDir/agentPath for an
    // mcp-kind install -- only the lockfile entry exists on disk for one.
    // Without the warning, a user who removes an mcp artifact is told it's
    // "Removed" while its .mcp.json entry (and any secret in its env) stays
    // live, and since the lockfile pin is now cleared, nothing surfaces this
    // again via list/update.
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });
    writeFileSync(
      join(dir, MCP_CONFIG_PATH),
      JSON.stringify(
        { mcpServers: { weather: { command: "npx", args: ["-y", "@x/weather"], env: { API_KEY: "secret-val" } } } },
        null,
        2,
      ),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/weather"]);

    expect(logSpy).toHaveBeenCalledWith("Removed alice/weather");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/alice\/weather.*still has an entry in .*\.mcp\.json/),
    );
    expect(process.exitCode).not.toBe(1);
    // remove() does not attempt a real mcp removal -- the entry (and its
    // secret) must be left exactly as it was, only warned about.
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather.env).toEqual({ API_KEY: "secret-val" });
  });

  it("does not warn about .mcp.json when removing a skill with no matching entry there", async () => {
    mkdirSync(join(dir, ".claude", "skills", "alice", "demo"), { recursive: true });
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { "unrelated-server": { url: "https://x" } } }, null, 2));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await remove(["alice/demo"]);

    expect(warnSpy).not.toHaveBeenCalled();
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
