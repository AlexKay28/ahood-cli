import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LockEntry = { version: string; checksum_sha256: string };
export type Lockfile = Record<string, LockEntry>;

export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    // Silently treating a corrupted lockfile as "nothing installed" is how
    // every existing pin gets permanently discarded on the very next write --
    // refuse instead, so a truncated/interrupted write is a loud, fixable
    // error rather than silent data loss.
    throw new Error(
      `Lockfile at ${path} is corrupted and could not be parsed as JSON. Fix or delete it before continuing.`,
    );
  }
}

// Generalized so callers other than the lockfile itself (e.g. add.ts's
// .mcp.json merge, which sits right next to the lockfile and can hold other
// servers' secrets) get the same crash-safety guarantee instead of a bare
// writeFileSync that risks truncating the file on interruption.
export function writeJsonFileAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a process interrupted mid-write never leaves a
  // truncated file on disk -- a reader always sees either the old or the new
  // complete content, never a partial one.
  const tmpPath = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function writeLockfile(path: string, lockfile: Lockfile): void {
  writeJsonFileAtomic(path, lockfile);
}

// A lock directory is stale if the PID recorded inside it (written by the
// acquirer below) belongs to a process that's no longer running -- signal 0
// doesn't actually deliver a signal, just probes whether the process could
// be signaled. ESRCH means it's dead; EPERM means it's alive but owned by
// someone else, which is conservatively treated as still alive since that
// can't be disproven. A missing/unparseable pid file is also treated as
// "not stale" -- either a lock from before this file existed, or another
// process is still mid-way through acquiring (mkdirSync succeeded, the pid
// write hasn't landed yet) -- safer to wait it out than to reclaim a lock
// that's actually still being set up.
function isLockStale(pidFile: string): boolean {
  let pidText: string;
  try {
    pidText = readFileSync(pidFile, "utf-8");
  } catch {
    return false;
  }
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// Simple advisory lock via mkdir's atomicity (EEXIST on a second caller),
// so two concurrent `ahood skill add`/`remove` invocations against the same
// project don't race a read-modify-write and silently drop one another's
// entry. Exported so other same-directory JSON files with the same
// read-modify-write shape (e.g. add.ts's .mcp.json merge) can reuse it
// instead of duplicating the pattern.
//
// The lock directory holds a `pid` file naming its holder, so a process
// that finds the lock held can tell a live holder from one that was
// hard-killed (SIGKILL/OOM) mid-critical-section: without this, such a lock
// is never released, and every subsequent add/remove/update in that project
// busy-waits out the full timeout below and then fails permanently until a
// human manually deletes the stale directory (ahood-cli#100).
export function withLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockDir = `${path}.lock`;
  const pidFile = join(lockDir, "pid");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      // Best-effort: mkdirSync above is what actually holds the lock: if
      // this write fails for some reason, the lock is still correctly held,
      // just without staleness detection for this particular acquisition.
      try {
        writeFileSync(pidFile, String(process.pid));
      } catch {
        // non-fatal, see comment above
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isLockStale(pidFile)) {
        // Reclaim it. Best-effort removal: if a concurrent process wins the
        // race and reclaims (or a live holder finishes and releases) first,
        // this just falls through to the normal wait/retry below instead of
        // throwing.
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // lost the race -- fall through to wait/retry
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the lockfile lock at ${lockDir}. If no other ahood process is running, delete that directory manually.`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function writeLockfileEntry(path: string, ownerSlashSkill: string, entry: LockEntry): void {
  withLock(path, () => {
    const lockfile = readLockfile(path);
    lockfile[ownerSlashSkill] = entry;
    writeLockfile(path, lockfile);
  });
}

// Thrown by writeLockfileEntryVerifyingChecksum -- carries the conflicting
// entry so the caller (add.ts) can build its own user-facing message and
// decide what to roll back (an already-extracted skill dir, an already-
// written agent file, an already-merged .mcp.json entry).
export class LockfileChecksumConflictError extends Error {
  constructor(public existing: LockEntry) {
    super("Lockfile checksum conflict");
  }
}

// add.ts's checksum-pin tamper-detection guard used to read the lockfile
// (unlocked) well before the eventual writeLockfileEntry call, which
// acquires its OWN, separate lock later -- two independently-locked steps,
// not one atomic operation. Under concurrent installs of "the same"
// version with different (tampered) checksums, both processes' unlocked
// reads could see no conflict, so both writes would proceed and whichever
// wins the later lock silently overwrites the other with no error ever
// surfaced -- exactly the tampering this guard exists to catch
// (ahood-cli#101). Performing the read, the check, and the write inside one
// locked critical section closes that window: whichever caller's write
// actually lands is checked against the lockfile state as it exists AT
// THAT MOMENT, not a possibly-stale snapshot from earlier.
export function writeLockfileEntryVerifyingChecksum(path: string, ownerSlashSkill: string, entry: LockEntry): void {
  withLock(path, () => {
    const lockfile = readLockfile(path);
    const existing = lockfile[ownerSlashSkill];
    if (existing && existing.version === entry.version && existing.checksum_sha256 !== entry.checksum_sha256) {
      throw new LockfileChecksumConflictError(existing);
    }
    lockfile[ownerSlashSkill] = entry;
    writeLockfile(path, lockfile);
  });
}

export function removeLockfileEntry(path: string, ownerSlashSkill: string): boolean {
  return withLock(path, () => {
    const lockfile = readLockfile(path);
    const existed = ownerSlashSkill in lockfile;
    delete lockfile[ownerSlashSkill];
    writeLockfile(path, lockfile);
    return existed;
  });
}
