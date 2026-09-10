import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
