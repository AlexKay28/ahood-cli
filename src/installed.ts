// The user-level install record (ahood#979): ~/.ahood/installed.json, one
// entry per artifact install across every project on this machine. It is the
// input to `ahood status` (POST /api/v1/me/status) and `ahood sync`, and where
// `ahood pin` records a pin.
//
// It does NOT replace the project lockfile (.claude/skills.lock.json, spec.ts
// LOCKFILE_PATH): that one stays the per-project source of truth for what is
// installed and with which checksum, and every install/remove keeps writing
// it exactly as before. This file only indexes those installs so a command
// run anywhere can see all of them. An install recorded before this file
// existed is picked up lazily (migrateProjectLockfile) the next time a
// status/sync/pin command runs inside that project.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readLockfile, withLock, writeJsonFileAtomic } from "./lockfile.js";
import { agentPath, LOCKFILE_PATH, MCP_CONFIG_PATH, pinnedFilePath, skillDir } from "./spec.js";
import { isPinnedFileKind, localInstalledKind, type CliKind } from "./kinds.js";

export const INSTALLED_FILE_ENV = "AHOOD_INSTALLED_FILE";
export const INSTALLED_FILE_VERSION = 1;

export type InstalledItem = {
  owner: string;
  slug: string;
  version: string;
  /** null only for a migrated legacy pin whose kind its files cannot tell. */
  kind: CliKind | null;
  /** Absolute path of what the install wrote (dir, file, or .mcp.json). */
  installedPath: string;
  /** Absolute project directory the install ran in (its lockfile's root). */
  projectDir: string;
  installedAt: string;
  checksum_sha256?: string;
  /** The version `ahood pin` held this install at; sync never moves past it. */
  pinned?: string;
  /** Set when the entry was imported from a project lockfile, not recorded live. */
  migrated?: true;
};

export type InstalledFile = { version: number; items: InstalledItem[] };

export function installedFilePath(): string {
  return process.env[INSTALLED_FILE_ENV] || join(homedir(), ".ahood", "installed.json");
}

export function itemKey(item: { owner: string; slug: string }): string {
  return `${item.owner}/${item.slug}`;
}

function sameInstall(a: InstalledItem, b: { owner: string; slug: string; installedPath: string }): boolean {
  return itemKey(a) === itemKey(b) && a.installedPath === b.installedPath;
}

export function readInstalled(path: string = installedFilePath()): InstalledFile {
  if (!existsSync(path)) return { version: INSTALLED_FILE_VERSION, items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Same refusal as the project lockfile: overwriting an unparseable file on
    // the next write would silently drop every recorded install and pin.
    throw new Error(`${path} is corrupted and could not be parsed as JSON. Fix or delete it before continuing.`);
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error(`${path} has no "items" array. Fix or delete it before continuing.`);
  return { version: INSTALLED_FILE_VERSION, items: items as InstalledItem[] };
}

/** Read-modify-write under the same advisory lock the project lockfile uses. */
export function updateInstalled<T>(fn: (file: InstalledFile) => T, path: string = installedFilePath()): T {
  return withLock(path, () => {
    const file = readInstalled(path);
    const result = fn(file);
    writeJsonFileAtomic(path, file);
    return result;
  });
}

/** Where an install of `kind` lands, relative to the current directory. */
export function installedPathFor(kind: CliKind | null, owner: string, slug: string): string {
  if (kind === "agent") return resolve(agentPath(owner, slug));
  if (kind === "mcp") return resolve(MCP_CONFIG_PATH);
  if (isPinnedFileKind(kind)) return resolve(pinnedFilePath(kind, owner, slug));
  return resolve(skillDir(owner, slug));
}

/** Called after every successful install/update in the current directory. A
 *  re-install keeps the entry's pin; anything else about it is replaced. */
export function recordInstall(entry: { owner: string; slug: string; version: string; kind: CliKind; checksum_sha256: string }): void {
  const item: InstalledItem = {
    owner: entry.owner,
    slug: entry.slug,
    version: entry.version,
    kind: entry.kind,
    installedPath: installedPathFor(entry.kind, entry.owner, entry.slug),
    projectDir: process.cwd(),
    installedAt: new Date().toISOString(),
    checksum_sha256: entry.checksum_sha256,
  };
  updateInstalled((file) => {
    const existing = file.items.find((i) => sameInstall(i, item));
    if (existing?.pinned !== undefined) item.pinned = existing.pinned;
    file.items = [...file.items.filter((i) => !sameInstall(i, item)), item];
  });
}

/** Best-effort wrapper: the project install already landed, so failing to
 *  index it must never turn a successful install into an error. */
export function recordInstallOrWarn(entry: Parameters<typeof recordInstall>[0]): void {
  try {
    recordInstall(entry);
  } catch (error) {
    console.warn(
      `WARNING: installed, but could not record it in ${installedFilePath()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `ahood <kind> remove` in the current directory drops its entry too. */
export function forgetInstallOrWarn(owner: string, slug: string): void {
  try {
    const projectDir = process.cwd();
    updateInstalled((file) => {
      file.items = file.items.filter((i) => !(itemKey(i) === `${owner}/${slug}` && i.projectDir === projectDir));
    });
  } catch (error) {
    console.warn(`WARNING: could not update ${installedFilePath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Lazy migration: every pin in the current directory's project lockfile that
 *  this file does not know about yet is imported. Returns how many were. A
 *  directory with no project lockfile is a no-op (and writes nothing). */
export function migrateProjectLockfile(): number {
  const lockPath = resolve(LOCKFILE_PATH);
  if (!existsSync(lockPath)) return 0;
  const pins = readLockfile(lockPath);
  const projectDir = process.cwd();
  const fresh: InstalledItem[] = [];
  for (const [key, pin] of Object.entries(pins)) {
    const [owner, slug, extra] = key.split("/");
    if (!owner || !slug || extra !== undefined || typeof pin?.version !== "string") continue;
    const kind = localInstalledKind(owner, slug, pin) ?? null;
    fresh.push({
      owner,
      slug,
      version: pin.version,
      kind,
      installedPath: installedPathFor(kind, owner, slug),
      projectDir,
      installedAt: new Date().toISOString(),
      checksum_sha256: pin.checksum_sha256,
      migrated: true,
    });
  }
  const known = readInstalled().items;
  const missing = fresh.filter((f) => !known.some((k) => itemKey(k) === itemKey(f) && k.projectDir === f.projectDir));
  if (missing.length === 0) return 0;
  return updateInstalled((file) => {
    const add = missing.filter((f) => !file.items.some((k) => itemKey(k) === itemKey(f) && k.projectDir === f.projectDir));
    file.items.push(...add);
    return add.length;
  });
}

/** Lazy migration, best-effort: a broken project lockfile must not stop a
 *  read-only `ahood status` from reporting everything else. */
export function migrateProjectLockfileOrWarn(): void {
  try {
    migrateProjectLockfile();
  } catch (error) {
    console.warn(`WARNING: could not import ${LOCKFILE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
