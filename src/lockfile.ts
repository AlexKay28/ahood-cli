import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

function writeLockfile(path: string, lockfile: Lockfile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a process interrupted mid-write never leaves a
  // truncated lockfile on disk -- a reader always sees either the old or the
  // new complete content, never a partial one.
  const tmpPath = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  writeFileSync(tmpPath, JSON.stringify(lockfile, null, 2) + "\n");
  renameSync(tmpPath, path);
}

// Simple advisory lock via mkdir's atomicity (EEXIST on a second caller),
// so two concurrent `ahood add`/`remove` invocations against the same
// project don't race a read-modify-write and silently drop one another's
// entry.
function withLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
    rmdirSync(lockDir);
  }
}

export function writeLockfileEntry(path: string, ownerSlashSkill: string, entry: LockEntry): void {
  withLock(path, () => {
    const lockfile = readLockfile(path);
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
