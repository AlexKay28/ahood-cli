// Planning and applying file edits for `ahood setup` (ahood#980). Every
// harness module only PLANS: it reads the current file and returns the bytes
// it wants there. This module is the single writer, so the rules hold for
// every harness at once:
//   - unchanged content is never rewritten and never backed up (idempotent);
//   - an existing file is copied to <file>.ahood-backup-<timestamp> before it
//     is edited or deleted -- unless it is byte-identical to what setup itself
//     would write, i.e. regenerable;
//   - --dry-run computes and prints the same plan and writes nothing;
//   - an edited file keeps its permission bits (or gets `mode`), and a file
//     holding a token never has that token copied into a backup (ahood#990).
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { SetupRefusedError } from "./errors.js";
import { displayPath } from "./paths.js";

export type FileChange = {
  path: string;
  /** Current content, or null when the file does not exist. */
  before: string | null;
  /** Desired content, or null to delete the file. */
  after: string | null;
  /** What this file is for, shown in the summary. */
  what: string;
  /** Content setup itself would have written here; a file equal to it needs no backup. */
  regenerable?: string;
  /** Permission bits to give the written file (0o600 for a token file setup creates or the user let it tighten). */
  mode?: number;
  /** Token values in `before`/`after`: redacted from any backup, which is itself written 0600. */
  secrets?: string[];
};

export type ChangeAction = "create" | "update" | "delete" | "unchanged";

export type AppliedChange = { path: string; what: string; action: ChangeAction; backup?: string };

export function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function actionOf(change: FileChange): ChangeAction {
  if (change.before === change.after) return "unchanged";
  if (change.before === null) return "create";
  if (change.after === null) return "delete";
  return "update";
}

function needsBackup(change: FileChange): boolean {
  if (change.before === null) return false;
  return change.regenerable === undefined || change.before !== change.regenerable;
}

export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * The single backup writer for every harness: copies `path` to
 * <path>.ahood-backup-<stamp>, or -<stamp>-1, -2, ... when that name is taken,
 * so a backup is never overwritten -- an install and a remove within the same
 * millisecond would otherwise replace the user's original with our own edit.
 * COPYFILE_EXCL makes the "not taken" check and the copy one atomic step.
 */
export function writeBackup(path: string, stamp: string, secrets: string[] = []): string {
  const redact = secrets.filter(Boolean);
  for (let n = 0; ; n++) {
    const candidate = `${path}.ahood-backup-${stamp}${n === 0 ? "" : `-${n}`}`;
    try {
      if (redact.length === 0) {
        copyFileSync(path, candidate, fsConstants.COPYFILE_EXCL);
      } else {
        let content = readFileSync(path, "utf-8");
        for (const secret of redact) content = content.split(secret).join(REDACTED_TOKEN);
        writeFileSync(candidate, content, { flag: "wx", mode: 0o600 });
        chmodSync(candidate, 0o600);
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** What a backup holds in place of a token setup stored. */
export const REDACTED_TOKEN = "<ahood token removed from this backup>";

/** The permission bits of `path`, or null when it does not exist. */
export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

// The rename swaps in a new inode, so without the chmod an edited file would
// silently take the umask default (e.g. a user's 0600 config.toml -> 0644).
function writeAtomic(path: string, content: string, mode: number | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  const keep = mode ?? fileMode(path) ?? undefined;
  const tmp = `${path}.ahood-tmp-${process.pid}`;
  writeFileSync(tmp, content, keep === undefined ? undefined : { mode: keep });
  if (keep !== undefined) chmodSync(tmp, keep);
  renameSync(tmp, path);
}

export function applyChanges(changes: FileChange[], opts: { dryRun: boolean; stamp: string }): AppliedChange[] {
  const results: AppliedChange[] = [];
  for (const change of changes) {
    const action = actionOf(change);
    const result: AppliedChange = { path: change.path, what: change.what, action };
    const backupWanted = action !== "unchanged" && needsBackup(change);
    if (backupWanted) result.backup = `${change.path}.ahood-backup-${opts.stamp}`;
    results.push(result);
    if (opts.dryRun || action === "unchanged") continue;
    if (backupWanted) result.backup = writeBackup(change.path, opts.stamp, change.secrets);
    if (change.after === null) {
      unlinkSync(change.path);
      removeEmptyDir(dirname(change.path));
    } else {
      writeAtomic(change.path, change.after, change.mode);
    }
  }
  return results;
}

// A dir setup created for one file (~/.codex/skills/ahood/) goes with it --
// only when empty, so a backup left beside the file keeps it.
function removeEmptyDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // best effort
  }
}

export function formatChanges(results: AppliedChange[], dryRun: boolean): string[] {
  const verb: Record<ChangeAction, string> = dryRun
    ? { create: "would create", update: "would update", delete: "would delete", unchanged: "unchanged" }
    : { create: "created", update: "updated", delete: "deleted", unchanged: "unchanged" };
  return results.map((r) => {
    const backup = r.backup ? ` (backup: ${displayPath(r.backup)})` : "";
    return `  ${verb[r.action].padEnd(12)} ${displayPath(r.path)} -- ${r.what}${backup}`;
  });
}

// ---- files that are wholly ours (a command file, a skill, a snippet) -------

/** A line carried by every file setup owns outright; its presence is how we know the file is ours. */
export const OWNED_MARKER = "managed by `ahood setup`";

function isOwned(content: string): boolean {
  return content.includes(OWNED_MARKER);
}

export function planOwnedFile(path: string, desired: string, what: string): FileChange {
  const before = readIfExists(path);
  if (before !== null && !isOwned(before)) {
    throw new SetupRefusedError(
      `${displayPath(path)} already exists and was not written by \`ahood setup\` -- leaving it alone. ` +
        "Move it aside and re-run if you want ahood's version; nothing was changed.",
    );
  }
  return { path, before, after: desired, what, regenerable: desired };
}

/** Deletes a file only if it is ours; a same-named file of the user's is left (and reported). */
export function planOwnedFileRemoval(path: string, current: string, what: string, notes: string[]): FileChange | null {
  const before = readIfExists(path);
  if (before === null) return null;
  if (!isOwned(before)) {
    notes.push(`left ${displayPath(path)}: it was not written by \`ahood setup\`.`);
    return null;
  }
  return { path, before, after: null, what, regenerable: current };
}
