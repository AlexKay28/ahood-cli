import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readLockfile,
  withLock,
  writeLockfileEntry,
  removeLockfileEntry,
  writeLockfileEntryVerifyingChecksum,
  LockfileChecksumConflictError,
} from "../src/lockfile.js";

describe("lockfile", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-lock-test-"));
    lockPath = join(dir, ".claude", "skills.lock.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty object when no lockfile exists", () => {
    expect(readLockfile(lockPath)).toEqual({});
  });

  it("writes and reads back an entry", () => {
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc123" });
    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc123" },
    });
  });

  it("preserves other entries when writing a new one", () => {
    writeLockfileEntry(lockPath, "alice/skill-a", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "bob/skill-b", { version: "2.0.0", checksum_sha256: "bbb" });
    expect(Object.keys(readLockfile(lockPath))).toEqual(["alice/skill-a", "bob/skill-b"]);
  });

  it("overwrites an existing entry for the same skill (used by update)", () => {
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.1.0", checksum_sha256: "bbb" });
    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.1.0", checksum_sha256: "bbb" },
    });
  });

  it("removeLockfileEntry deletes exactly the named entry", () => {
    writeLockfileEntry(lockPath, "alice/skill-a", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "bob/skill-b", { version: "2.0.0", checksum_sha256: "bbb" });
    removeLockfileEntry(lockPath, "alice/skill-a");
    expect(readLockfile(lockPath)).toEqual({
      "bob/skill-b": { version: "2.0.0", checksum_sha256: "bbb" },
    });
  });

  it("throws instead of silently discarding a corrupted lockfile", () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "{not valid json");
    expect(() => readLockfile(lockPath)).toThrow(/corrupted/);
  });

  it("does not lose entries across many back-to-back writes (lock acquire/release round-trips cleanly)", async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() =>
        writeLockfileEntry(lockPath, `owner/skill-${i}`, { version: "1.0.0", checksum_sha256: `hash-${i}` }),
      ),
    );
    await Promise.all(writes);
    expect(Object.keys(readLockfile(lockPath))).toHaveLength(8);
  });

  it("reclaims a lock directory left behind by a process that no longer exists, instead of hanging until the timeout (#100)", () => {
    const lockDir = `${lockPath}.lock`;
    mkdirSync(lockDir, { recursive: true });
    // A process that has already exited by the time spawnSync returns --
    // its pid is guaranteed dead (barring the astronomically unlikely case
    // of immediate pid reuse), simulating a hard-killed (SIGKILL/OOM) lock
    // holder.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(lockDir, "pid"), String(dead.pid));

    const start = Date.now();
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });
    const elapsed = Date.now() - start;

    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc" },
    });
    // Reclaimed almost immediately -- the old code path would instead sit in
    // the wait/retry loop for close to the full 5s timeout.
    expect(elapsed).toBeLessThan(2000);
    expect(existsSync(lockDir)).toBe(false);
  });

  describe("an unremovable stale lock (#140)", () => {
    // Every case here runs withLock in a real child process, the way
    // tests/index.test.ts exercises the built CLI, because the regression
    // being guarded is an infinite *synchronous* loop: it blocks the event
    // loop, so no in-process test timeout could ever interrupt it, and only a
    // process the OS can kill bounds it.
    //
    // `patch` is CJS run before the import, with `lockPath`/`lockDir`/`fs` in
    // scope. Mutating the `node:fs` module object from CJS is visible to the
    // named imports inside the loaded ESM, which is what lets a case script
    // the exact removal failure it needs instead of depending on what the
    // filesystem underneath the test happens to do.
    function withLockInChild(patch = ""): { child: ReturnType<typeof spawnSync>; elapsed: number } {
      const builtLockfile = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lockfile.js");
      expect(existsSync(builtLockfile), "run `npm run build` before the tests -- these cases need dist/").toBe(true);
      const script = `
        const fs = require("node:fs");
        const lockPath = ${JSON.stringify(lockPath)};
        const lockDir = lockPath + ".lock";
        ${patch}
        import(${JSON.stringify(pathToFileURL(builtLockfile).href)}).then(({ withLock }) => {
          try { withLock(lockPath, () => {}); console.log("ACQUIRED"); }
          catch (error) { console.log("THREW " + error.message); }
        });`;
      const start = Date.now();
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
      return { child, elapsed: Date.now() - start };
    }

    // A lock directory whose recorded holder has already exited by the time
    // spawnSync returns -- its pid is guaranteed dead (barring the
    // astronomically unlikely case of immediate pid reuse), the shape a
    // hard-killed (SIGKILL/OOM) holder leaves behind.
    function plantStaleLock(): string {
      const lockDir = `${lockPath}.lock`;
      mkdirSync(lockDir, { recursive: true });
      const dead = spawnSync(process.execPath, ["-e", ""]);
      writeFileSync(join(lockDir, "pid"), String(dead.pid));
      return lockDir;
    }

    // The property that matters in every case below, whatever the wording of
    // the error: the call came back on its own (a signal means the timeout
    // above had to kill a spin), and it did not hand out a lock it never took.
    function expectGaveUpOnItsOwn(child: ReturnType<typeof spawnSync>): void {
      expect(child.signal, `withLock never returned; it spun past its own deadline (stderr: ${child.stderr})`).toBe(
        null,
      );
      expect(child.stdout).toContain("THREW");
      expect(child.stdout).not.toContain("ACQUIRED");
    }

    // Removing the lock directory needs write permission on its PARENT, and
    // removing the pid file inside it needs write permission on the lock
    // directory ITSELF. Dropping both is what makes this case independent of
    // its environment: a recursive removal that can take neither leaves the
    // whole thing exactly as it was, so the retry keeps seeing a stale lock,
    // on every Node version and filesystem. (Root bypasses both checks, and
    // the condition simply cannot be provoked there.)
    it.skipIf(process.getuid?.() === 0)(
      "gives up within its deadline instead of spinning forever, and names the real problem",
      () => {
        const lockDir = plantStaleLock();
        const guardedDir = dirname(lockPath);
        chmodSync(lockDir, 0o500);
        chmodSync(guardedDir, 0o500);

        let result: ReturnType<typeof withLockInChild>;
        try {
          result = withLockInChild();
        } finally {
          // Before any assertion, so a failure still leaves afterEach able to
          // delete the temp directory.
          chmodSync(guardedDir, 0o700);
          chmodSync(lockDir, 0o700);
        }

        expectGaveUpOnItsOwn(result.child);
        // The message must name the real problem -- a directory this process
        // cannot remove -- not "waiting for a lock", which would send the user
        // hunting for an ahood process that provably exited.
        expect(result.child.stdout).toContain("Could not reclaim the stale lock");
        expect(result.child.stdout).toContain(lockDir);
        expect(result.child.stdout).toContain("delete it manually");
        // withLock's own deadline is 5s; anything near the kill above means it
        // spun instead of giving up.
        expect(result.elapsed).toBeLessThan(20_000);
      },
      60_000,
    );

    // The CI-only failure behind ahood-cli#145: a recursive removal deletes
    // the directory's CONTENTS and only then fails on the directory itself,
    // so the pid file is gone by the next retry -- and a lock with no pid
    // file is deliberately "not stale" (another process may be mid-acquire),
    // so the reclaim branch never runs again. Whether that partial removal
    // happens at all differs between Node versions, which is why it is
    // scripted here rather than provoked through the filesystem.
    it(
      "still reports the unremovable lock when the failed removal took the pid file with it",
      () => {
        const lockDir = plantStaleLock();

        const { child } = withLockInChild(`
          const realRmSync = fs.rmSync;
          fs.rmSync = (target, options) => {
            if (target !== lockDir) return realRmSync(target, options);
            realRmSync(lockDir + "/pid", { force: true });
            const error = new Error("EACCES: permission denied, rmdir");
            error.code = "EACCES";
            throw error;
          };
        `);

        expectGaveUpOnItsOwn(child);
        expect(child.stdout).toContain("Could not reclaim the stale lock");
        expect(child.stdout).toContain("EACCES");
        expect(child.stdout).not.toContain("Timed out waiting for the lock");
      },
      60_000,
    );

    // The other half of remembering a reclaim failure: the memory must not
    // outlive the directory it describes. A process that DOES have permission
    // (a root/owner ahood in another terminal) can clear that directory and
    // take the lock for real, and "the process that held it is gone" would
    // then be a confident lie about a lock somebody is legitimately holding.
    it(
      "falls back to the plain timeout when the directory it failed to remove was replaced by a live holder",
      () => {
        plantStaleLock();

        const { child } = withLockInChild(`
          const realRmSync = fs.rmSync;
          fs.rmSync = (target, options) => {
            if (target !== lockDir) return realRmSync(target, options);
            fs.rmSync = realRmSync;
            realRmSync(lockDir, { recursive: true, force: true });
            fs.mkdirSync(lockDir);
            fs.writeFileSync(lockDir + "/pid", String(process.pid));
            const error = new Error("EACCES: permission denied, rmdir");
            error.code = "EACCES";
            throw error;
          };
        `);

        expectGaveUpOnItsOwn(child);
        expect(child.stdout).toContain("Timed out waiting for the lock");
        expect(child.stdout).not.toContain("Could not reclaim the stale lock");
      },
      60_000,
    );
  });

  describe("withLock timeout message", () => {
    // Holds the lock with THIS process's pid so isLockStale can't reclaim it,
    // then jumps Date.now past withLock's deadline on the first in-loop read,
    // so the timeout branch is reached without spending its real 5s.
    function timeoutMessageFor(path: string): string {
      const lockDir = `${path}.lock`;
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 10_000);

      let caught: unknown;
      try {
        withLock(path, () => {
          throw new Error("the critical section must not run while the lock is held");
        });
      } catch (error) {
        caught = error;
      }
      return (caught as Error).message;
    }

    it("names the guarded file when the lock being waited on guards .mcp.json (#123)", () => {
      const mcpPath = join(dir, ".mcp.json");

      const message = timeoutMessageFor(mcpPath);

      expect(message).toBe(
        `Timed out waiting for the lock on ${mcpPath} at ${mcpPath}.lock. If no other ahood process is running, delete that directory manually.`,
      );
      // The whole point of #123: a .mcp.json timeout must not send the user
      // looking at "the lockfile".
      expect(message).not.toMatch(/lockfile/i);
    });

    it("still reads correctly for a timeout on the real lockfile", () => {
      const message = timeoutMessageFor(lockPath);

      expect(message).toBe(
        `Timed out waiting for the lock on ${lockPath} at ${lockPath}.lock. If no other ahood process is running, delete that directory manually.`,
      );
    });
  });

  describe("writeLockfileEntryVerifyingChecksum", () => {
    it("writes normally when there is no conflicting entry", () => {
      writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc" },
      });
    });

    it("overwrites cleanly when the existing entry is for a different version (an update, not a conflict)", () => {
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });
      writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.1.0", checksum_sha256: "bbb" });
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.1.0", checksum_sha256: "bbb" },
      });
    });

    it("throws LockfileChecksumConflictError and leaves the existing entry untouched on a same-version checksum mismatch (#101)", () => {
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });

      let caught: unknown;
      try {
        writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "tampered" });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(LockfileChecksumConflictError);
      expect((caught as LockfileChecksumConflictError).existing).toEqual({ version: "1.0.0", checksum_sha256: "aaa" });
      // The lockfile itself must be unchanged -- the conflicting write never landed.
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "aaa" },
      });
    });

    it("catches a conflict written by a concurrent writer AFTER an earlier unlocked read saw none, closing the TOCTOU window", () => {
      // Simulates add()'s early, unlocked fast-fail check seeing no entry at
      // all, then -- before this call's OWN locked check-and-write runs -- a
      // "concurrent process" (represented here by a plain writeLockfileEntry
      // call in between) pins a conflicting checksum for the same version.
      expect(readLockfile(lockPath)["alice/my-skill"]).toBeUndefined();
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "concurrent-writer-won" });

      expect(() =>
        writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "this-writer-lost" }),
      ).toThrow(LockfileChecksumConflictError);
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "concurrent-writer-won" },
      });
    });
  });
});
