import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// withLock wrapped in vi.fn (default pass-through to the real implementation
// via `...actual`) so a single test can override it with a synchronous
// throw to simulate a lock-acquisition/write failure, without the 5s real
// lock-timeout wait a genuine contention test would need. Every other test
// in this file gets the real, unmodified withLock behavior.
vi.mock("../src/lockfile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lockfile.js")>();
  return { ...actual, withLock: vi.fn(actual.withLock) };
});
import { remove } from "../src/commands/remove.js";
import { writeLockfileEntry, readLockfile, withLock } from "../src/lockfile.js";
import { agentPath, skillDir, MCP_CONFIG_PATH } from "../src/spec.js";
import { hashMcpServerConfig } from "../src/commands/add.js";

// remove() reads a confirmation line from stdin via node:readline/promises --
// feed it one directly instead of touching the real terminal, matching
// unpublish.test.ts's own stub.
function stubStdio(answer: string): { promptedWith(): string } {
  const written: string[] = [];
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
  const fakeStdout = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream & { fd: 1 };
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(fakeStdout);
  queueMicrotask(() => {
    fakeStdin.push(`${answer}\n`);
    fakeStdin.push(null);
  });
  return { promptedWith: () => written.join("") };
}

describe("remove", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-remove-test-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects with a usage error when no spec is given", async () => {
    await expect(remove([])).rejects.toThrow(/Usage: ahood skill remove/);
  });

  it("does not remove anything when the user does not confirm with 'yes' (#98)", async () => {
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/demo", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });
    const stdio = stubStdio("n");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/demo"]);

    expect(existsSync(join(dir, skillDir("alice", "demo")))).toBe(true);
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toHaveProperty("alice/demo");
    expect(logSpy).toHaveBeenCalledWith("Aborted.");
    expect(stdio.promptedWith()).toMatch(/Remove alice\/demo/);
  });

  it("removes the installed skill directory and its lockfile entry once confirmed with 'yes'", async () => {
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    writeFileSync(join(dir, skillDir("alice", "demo"), "SKILL.md"), "# demo");
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/demo", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });
    stubStdio("yes");

    await remove(["alice/demo"]);

    expect(existsSync(join(dir, skillDir("alice", "demo")))).toBe(false);
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toEqual({});
  });

  it("--yes bypasses the prompt entirely, for scripted/CI use", async () => {
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/demo", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    await remove(["alice/demo", "--yes"]);

    expect(existsSync(join(dir, skillDir("alice", "demo")))).toBe(false);
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toEqual({});
  });

  it("removing one skill does not touch a sibling skill from the same owner", async () => {
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    mkdirSync(join(dir, skillDir("alice", "other")), { recursive: true });

    await remove(["alice/demo", "--yes"]);

    expect(existsSync(join(dir, skillDir("alice", "demo")))).toBe(false);
    expect(existsSync(join(dir, skillDir("alice", "other")))).toBe(true);
  });

  it("reports failure instead of a false 'Removed' when nothing was installed, without prompting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // No stdio stub -- if remove() prompted here, reading from the real
    // stdin in a test run would hang, so this also pins that the not-
    // installed check happens BEFORE the confirm() gate.
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

    await remove(["alice/reviewer", "--yes"]);

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

    await remove(["alice/weather", "--yes"]);

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

  it("actually deletes the .mcp.json entry when its recorded fingerprint still matches what's on disk (ahood-cli#169)", async () => {
    const entry = { command: "npx", args: ["-y", "@x/weather@1.0.0"], env: { API_KEY: "secret-val" } };
    writeFileSync(
      join(dir, MCP_CONFIG_PATH),
      JSON.stringify({ mcpServers: { weather: entry, other: { url: "https://x" } } }, null, 2),
    );
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
      mcp_config_hash: hashMcpServerConfig(entry),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/weather", "--yes"]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toBeUndefined();
    expect(mcpConfig.mcpServers.other).toEqual({ url: "https://x" }); // sibling entry untouched
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Removed alice/weather"));
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toEqual({});
  });

  it("does NOT delete, and warns with 'modified' wording, when the on-disk entry no longer matches the recorded fingerprint", async () => {
    const installedEntry = { command: "npx", args: ["-y", "@x/weather@1.0.0"], env: { API_KEY: "secret-val" } };
    const handEditedEntry = { command: "npx", args: ["-y", "@x/weather@1.0.0", "--extra-flag"], env: { API_KEY: "secret-val" } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: handEditedEntry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
      mcp_config_hash: hashMcpServerConfig(installedEntry),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/weather", "--yes"]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual(handEditedEntry);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/modified since install/));
    // Exactly one warning, and the readable-file wording -- a readable
    // .mcp.json must never reach the unreadable branch (ahood-cli#115).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("ahood could not check"));
    expect(logSpy).toHaveBeenCalledWith("Removed alice/weather");
  });

  it("falls through to the warning, not a false 'Removed (including its .mcp.json entry)', when the .mcp.json write itself fails", async () => {
    const entry = { command: "npx", args: ["-y", "@x/weather@1.0.0"], env: { API_KEY: "secret-val" } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: entry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
      mcp_config_hash: hashMcpServerConfig(entry),
    });

    // Simulates a lock-acquisition timeout or a write failure (EACCES/
    // ENOSPC/etc) -- without the fix, this exact scenario silently
    // swallowed the failure and printed a bare "Removed" with the entry
    // (and its secret) still live.
    vi.mocked(withLock).mockImplementationOnce(() => {
      throw new Error("simulated lock/write failure");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/weather", "--yes"]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/still has an entry in .*\.mcp\.json/));
    expect(logSpy).toHaveBeenCalledWith("Removed alice/weather"); // no "(including its .mcp.json entry)"
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual(entry); // untouched -- the write never happened
  });

  // readMcpConfig throws from three separate branches (invalid JSON, a
  // non-object top level, a non-object "mcpServers"), and .mcp.json is
  // explicitly shared with other MCP clients, so hand-edits that break it
  // are realistic. Each shape must still warn, since the lockfile's
  // mcp_config_hash proves ahood installed an entry there (ahood-cli#115).
  for (const [shape, contents] of [
    ["invalid JSON", '{"mcpServers": {"weather": {"command": "npx"},}}'],
    ["a non-object top level", "[]"],
    ["a non-object mcpServers", '{"mcpServers": []}'],
  ] as const) {
    it(`warns that the entry may still be live, naming the read failure, when .mcp.json is ${shape} (ahood-cli#115)`, async () => {
      writeFileSync(join(dir, MCP_CONFIG_PATH), contents);
      writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
        version: "1.0.0",
        checksum_sha256: "abc",
        mcp_config_hash: hashMcpServerConfig({ command: "npx", env: { API_KEY: "secret-val" } }),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await remove(["alice/weather", "--yes"]);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/alice\/weather may still have an entry in .*\.mcp\.json.*ahood could not check/s),
      );
      // Actionable for THIS case: "remove it manually" isn't possible until
      // the file parses again.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Fix the file, then delete the "weather" entry/));
      // ...and NOT readMcpConfig's own "fix or remove it" advice: removing
      // .mcp.json would take other MCP clients' servers with it.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("fix or remove it"));
      // The success line must not claim the .mcp.json entry went with it.
      expect(logSpy).toHaveBeenCalledWith("Removed alice/weather");
      // The file is left byte-for-byte alone -- remove() is not the strict
      // validator for a file it only merges into.
      expect(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8")).toBe(contents);
    });
  }

  it("stays silent about an unreadable .mcp.json when the lockfile records no mcp entry of ours (ahood-cli#115)", async () => {
    // A plain skill install has no mcp_config_hash, so a broken .mcp.json
    // here is somebody else's file and none of this command's business --
    // warning would be pure noise.
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    writeFileSync(join(dir, MCP_CONFIG_PATH), "{ not json");
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/demo", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/demo", "--yes"]);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Removed alice/demo");
  });

  it("does not warn about .mcp.json when removing a skill with no matching entry there", async () => {
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { "unrelated-server": { url: "https://x" } } }, null, 2));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await remove(["alice/demo", "--yes"]);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("rejects a spec that tries to traverse outside .claude/skills/ via '..'", async () => {
    mkdirSync(join(dir, skillDir("alice", "demo")), { recursive: true });
    mkdirSync(join(dir, skillDir("bob", "other")), { recursive: true });
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "outside", "important.txt"), "keep me");

    await expect(remove(["alice/..", "--yes"])).rejects.toThrow(/Invalid skill/);
    // The whole skills tree (every owner) must still be intact.
    expect(existsSync(join(dir, skillDir("alice", "demo")))).toBe(true);
    expect(existsSync(join(dir, skillDir("bob", "other")))).toBe(true);

    await expect(remove(["../outside", "--yes"])).rejects.toThrow(/Invalid owner/);
    expect(existsSync(join(dir, "outside", "important.txt"))).toBe(true);
  });
});
