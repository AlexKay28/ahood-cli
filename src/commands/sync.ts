import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createPatch } from "diff";
import { add, downloadVerifiedArchive, extractSingleFileContent, extractTarGz, fetchVersionMeta } from "./add.js";
import { loadStatusRows, type StatusRow } from "./status.js";
import { confirmYesNo, isInteractive } from "../confirm.js";
import { unrecognizedArgs } from "../flags.js";
import { itemKey } from "../installed.js";
import { isCliKind, isPinnedFileKind, KINDS, type CliKind } from "../kinds.js";
import { sanitizeDocumentForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood sync [<owner>/<slug> | <slug> ...] [--yes] [--dry-run] [--json]";

// `ahood sync` (ahood#979): moves installs that `ahood status` reports behind
// onto their target version (the latest, or the pinned version for a pinned
// install), one artifact at a time, and ONLY with consent: each artifact's
// unified diff against the files on disk is shown and answered y/N, `--yes`
// accepts every one, and with no terminal to ask on (and no --yes) it refuses
// before downloading anything. The write itself is the ordinary install path
// (`add` run in the install's own project directory), so the project
// lockfile, its checksum pin, the atomic swap and every rollback are exactly
// what `ahood skill add` does.

export type SyncAction = "updated" | "declined" | "would_update" | "skipped" | "failed";
export type SyncResult = {
  owner: string;
  slug: string;
  kind: string | null;
  from: string;
  to: string | null;
  installed_path: string;
  project_dir: string;
  action: SyncAction;
  reason?: string;
  diff?: string;
};

type FileMap = Map<string, Buffer>;

function walkFiles(root: string): FileMap {
  const out: FileMap = new Map();
  if (!existsSync(root)) return out;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.set(relative(root, full).split("\\").join("/"), readFileSync(full));
    }
  };
  if (statSync(root).isDirectory()) visit(root);
  return out;
}

const isBinary = (b: Buffer) => b.includes(0);

/** A unified diff of every file that differs between two file sets. */
export function diffFileMaps(before: FileMap, after: FileMap, fromLabel: string, toLabel: string): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const parts: string[] = [];
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && b && a.equals(b)) continue;
    if ((a && isBinary(a)) || (b && isBinary(b))) {
      parts.push(`Binary file ${path} ${!a ? "added" : !b ? "removed" : "differs"}\n`);
      continue;
    }
    parts.push(createPatch(path, a?.toString("utf-8") ?? "", b?.toString("utf-8") ?? "", fromLabel, toLabel));
  }
  return parts.join("\n");
}

/** The candidate's files vs the installed ones, as one unified diff. */
async function diffAgainstInstalled(row: StatusRow, kind: CliKind | null, buffer: Buffer, to: string): Promise<string> {
  const fromLabel = `installed ${row.installed_version}`;
  const toLabel = `registry ${to}`;
  if (kind !== null && kind !== "skill") {
    const rootDoc = KINDS[kind].rootDoc;
    const next = await extractSingleFileContent(buffer, rootDoc);
    const current = existsSync(row.installed_path) ? readFileSync(row.installed_path) : undefined;
    return diffFileMaps(new Map(current ? [[rootDoc, current]] : []), new Map([[rootDoc, next]]), fromLabel, toLabel);
  }
  const scratch = mkdtempSync(join(tmpdir(), "ahood-sync-"));
  try {
    await extractTarGz(buffer, scratch);
    return diffFileMaps(walkFiles(row.installed_path), walkFiles(scratch), fromLabel, toLabel);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs the ordinary install in the install's own project directory. In
 *  --json mode the install's own progress lines go to stderr, so stdout
 *  stays one JSON document. */
async function applyInProject(row: StatusRow, kind: CliKind | null, to: string, json: boolean): Promise<void> {
  const previousCwd = process.cwd();
  const log = console.log;
  if (json) console.log = (...a: unknown[]) => console.error(...a);
  try {
    process.chdir(row.project_dir);
    const spec = `${itemKey(row)}@${to}`;
    if (isPinnedFileKind(kind)) await add([spec], { noun: kind, kind });
    else await add([spec]);
  } finally {
    console.log = log;
    process.chdir(previousCwd);
  }
}

function matchesTarget(row: StatusRow, target: string): boolean {
  return target.includes("/") ? itemKey(row).toLowerCase() === target.toLowerCase() : row.slug.toLowerCase() === target.toLowerCase();
}

function base(row: StatusRow): Omit<SyncResult, "action"> {
  return {
    owner: row.owner,
    slug: row.slug,
    kind: row.kind,
    from: row.installed_version,
    to: row.sync_target,
    installed_path: row.installed_path,
    project_dir: row.project_dir,
  };
}

/** Rows with nothing to sync, and why -- reported, never acted on. */
function skipReason(row: StatusRow): string | null {
  if (row.status === "not_found") return "not found in the registry (or not visible to you)";
  if (row.missing) return `its files are gone from ${row.installed_path}; reinstall it with \`ahood ${row.kind ?? "skill"} add ${itemKey(row)}\``;
  if (row.sync_target === null) return null;
  if (row.kind === "mcp") {
    return `MCP servers can prompt for secrets; update it with \`ahood mcp update ${itemKey(row)}\` in ${row.project_dir}`;
  }
  return null;
}

export async function sync(args: string[]): Promise<void> {
  const yes = args.includes("--yes") || args.includes("-y");
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const positionals = unrecognizedArgs(args, ["--yes", "-y", "--dry-run", "--json"], []);
  const unknownFlag = positionals.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${USAGE}`);
  if (yes && dryRun) throw new UsageError(`--yes and --dry-run contradict each other.\n${USAGE}`);

  const { rows: allRows } = await loadStatusRows();
  let rows = allRows;
  if (positionals.length > 0) {
    const unmatched = positionals.filter((t) => !allRows.some((r) => matchesTarget(r, t)));
    if (unmatched.length > 0) {
      throw new UsageError(`Not installed (per \`ahood status\`): ${unmatched.join(", ")}\n${USAGE}`);
    }
    rows = allRows.filter((r) => positionals.some((t) => matchesTarget(r, t)));
  }

  const results: SyncResult[] = [];
  const candidates: StatusRow[] = [];
  for (const row of rows) {
    const reason = skipReason(row);
    if (reason !== null) results.push({ ...base(row), action: "skipped", reason });
    else if (row.sync_target !== null) candidates.push(row);
  }

  // Consent first, before a single download: with nobody to answer and no
  // --yes, nothing is fetched or written.
  if (candidates.length > 0 && !yes && !dryRun && (json || !isInteractive())) {
    const list = candidates.map((r) => `${itemKey(r)} ${r.installed_version} -> ${r.sync_target}`).join(", ");
    throw new UsageError(
      `ahood sync has ${candidates.length} update(s) to apply (${list}) but will not update without consent, and ` +
        (json ? "--json leaves no terminal to ask on" : "there is no terminal to ask on") +
        ". Re-run with --yes to accept them all, or --dry-run to only see the diffs.",
    );
  }

  for (const row of candidates) {
    const to = row.sync_target!;
    const key = itemKey(row);
    try {
      const meta = await fetchVersionMeta(row.owner, row.slug, to);
      const kind = isCliKind(meta.kind) ? meta.kind : row.kind !== null && isCliKind(row.kind) ? row.kind : null;
      if (kind === "mcp") {
        results.push({ ...base(row), kind, action: "skipped", reason: skipReason({ ...row, kind: "mcp" })! });
        continue;
      }
      const buffer = await downloadVerifiedArchive(row.owner, row.slug, meta);
      const diff = await diffAgainstInstalled(row, kind, buffer, to);

      if (!json) {
        console.log(`\n${key}: ${row.installed_version} -> ${to}  (${row.installed_path})`);
        console.log(diff ? sanitizeDocumentForTerminal(diff) : "(no file changes)");
      }
      if (dryRun) {
        results.push({ ...base(row), kind, action: "would_update", diff });
        continue;
      }
      if (!yes && !(await confirmYesNo(`Update ${key} to ${to}? [y/N] `))) {
        results.push({ ...base(row), kind, action: "declined" });
        continue;
      }
      await applyInProject(row, kind, to, json);
      results.push({ ...base(row), kind, action: "updated", ...(json ? { diff } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!json) console.error(`Failed to sync ${key}: ${message}`);
      results.push({ ...base(row), action: "failed", reason: message });
    }
  }

  if (json) {
    console.log(JSON.stringify({ results }));
  } else {
    for (const r of results.filter((x) => x.action === "skipped")) console.log(`Skipped ${itemKey(r)}: ${r.reason}`);
    const count = (a: SyncAction) => results.filter((r) => r.action === a).length;
    if (candidates.length === 0) console.log(rows.length === 0 ? "Nothing installed with ahood yet." : "Everything is up to date.");
    else if (dryRun) console.log(`\n${count("would_update")} update(s) would be applied; nothing was changed (--dry-run).`);
    else console.log(`\n${count("updated")} updated, ${count("declined")} declined, ${count("failed")} failed.`);
  }
  if (results.some((r) => r.action === "failed")) process.exitCode = 1;
}
