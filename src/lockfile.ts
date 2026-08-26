import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LockEntry = { version: string; checksum_sha256: string };
export type Lockfile = Record<string, LockEntry>;

export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeLockfile(path: string, lockfile: Lockfile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(lockfile, null, 2) + "\n");
}

export function writeLockfileEntry(path: string, ownerSlashSkill: string, entry: LockEntry): void {
  const lockfile = readLockfile(path);
  lockfile[ownerSlashSkill] = entry;
  writeLockfile(path, lockfile);
}

export function removeLockfileEntry(path: string, ownerSlashSkill: string): void {
  const lockfile = readLockfile(path);
  delete lockfile[ownerSlashSkill];
  writeLockfile(path, lockfile);
}
