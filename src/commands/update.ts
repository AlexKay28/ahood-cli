import { LOCKFILE_PATH, parseOwnerSkill } from "../spec.js";
import { readLockfile } from "../lockfile.js";
import { add, fetchVersionMeta } from "./add.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]";

// `update` is the only command that moves the lockfile pin forward -- `add`
// always resolves and pins whatever version it's given (or latest, once,
// at install time), matching the ADR's "reproducible by default" design.

// One row of `--dry-run` output: what's currently pinned vs. what "latest"
// resolves to right now, for a single skill. `changelog_md` is only ever
// populated when the versions actually differ -- an up-to-date skill has
// nothing to show, and resolving/printing a changelog nobody asked about
// would just be noise.
type UpdatePreview = {
  skill: string;
  current_version: string | null;
  latest_version: string;
  up_to_date: boolean;
  changelog_md: string | null;
};

async function previewSkill(ownerSlashSkill: string, currentVersion: string | null): Promise<UpdatePreview> {
  const { owner, skill } = parseOwnerSkill(ownerSlashSkill, USAGE);
  const meta = await fetchVersionMeta(owner, skill, "latest");
  const upToDate = currentVersion === meta.version;
  return {
    skill: ownerSlashSkill,
    current_version: currentVersion,
    latest_version: meta.version,
    up_to_date: upToDate,
    changelog_md: upToDate ? null : meta.changelog_md ?? null,
  };
}

function padRow(cells: string[], widths: number[]): string {
  return cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
}

// Prints a side-by-side current/latest table for every previewed skill, then
// -- for only the skills that actually have an update available -- the
// changelog for the version they'd move to. Nothing here touches disk or the
// network beyond the read-only resolution already done in previewSkill().
function printDryRunTable(previews: UpdatePreview[]): void {
  const header = ["SKILL", "CURRENT", "LATEST", "STATUS"];
  const rows = previews.map((p) => [
    p.skill,
    p.current_version ?? "(not installed)",
    p.latest_version,
    p.up_to_date ? "up to date" : "update available",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(padRow(header, widths));
  for (const row of rows) console.log(padRow(row, widths));

  const changed = previews.filter((p) => !p.up_to_date);
  if (changed.length === 0) {
    console.log("\nAll skills are already up to date.");
    return;
  }
  for (const p of changed) {
    console.log(`\n${p.skill}: ${p.current_version ?? "(not installed)"} -> ${p.latest_version}`);
    console.log(p.changelog_md ? p.changelog_md : "(no changelog available)");
  }
}

export async function update(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");
  if (jsonOutput && !dryRun) {
    throw new UsageError(`--json is only supported together with --dry-run.\n${USAGE}`);
  }
  const targets = args.filter((a) => a !== "--dry-run" && a !== "--json");

  const lockfile = readLockfile(LOCKFILE_PATH);
  const skillKeys = targets.length > 0 ? targets : Object.keys(lockfile);
  if (skillKeys.length === 0) {
    console.log("No installed skills to update.");
    return;
  }

  if (dryRun) {
    // Read-only preview: resolves "latest" for each skill via the same
    // fetchVersionMeta() add() itself uses, but never calls add() -- so
    // nothing is downloaded, extracted, or written to the lockfile.
    const previews: UpdatePreview[] = [];
    const failures: string[] = [];
    for (const key of skillKeys) {
      try {
        previews.push(await previewSkill(key, lockfile[key]?.version ?? null));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to resolve latest version for ${key}: ${message}`);
        failures.push(key);
      }
    }

    if (jsonOutput) {
      console.log(JSON.stringify(previews));
    } else if (previews.length > 0) {
      printDryRunTable(previews);
    }

    if (failures.length > 0) {
      console.error(`${failures.length} of ${skillKeys.length} skill(s) could not be resolved: ${failures.join(", ")}`);
      process.exitCode = 1;
    }
    return;
  }

  const failures: string[] = [];
  for (const ownerSlashSkill of skillKeys) {
    if (!lockfile[ownerSlashSkill]) {
      // Reachable two ways: an explicitly-named skill that was never
      // installed (`ahood skill add` is the right command for that -- `update`
      // must not silently install and pin it), or -- when targets came from
      // the lockfile itself -- the lockfile changing out from under us
      // mid-loop. Either way: skip, don't abort.
      console.warn(`Skipping ${ownerSlashSkill}: not currently installed.`);
      continue;
    }
    try {
      // add() always hits the .mcp.json collision check for an mcp-kind
      // entry that's already installed (that's the very definition of
      // "already installed" for that kind), so calling it unconditionally
      // here would make `ahood skill update` with no arguments permanently
      // report a failure and exit 1 for every user who has ever installed
      // an mcp artifact, even when nothing needs updating. fetchVersionMeta
      // already resolves `kind` as part of the normal "latest" lookup add()
      // itself does, so resolving it here first lets this skip cleanly
      // instead of updating and hitting that guaranteed error. This is a
      // skip-and-report-cleanly fix, not real mcp-update support.
      const { owner, skill } = parseOwnerSkill(ownerSlashSkill, USAGE);
      const meta = await fetchVersionMeta(owner, skill, "latest");
      if (meta.kind === "mcp") {
        console.warn(`Skipping ${ownerSlashSkill}: mcp artifacts aren't updatable via this command yet.`);
        continue;
      }
      await add([ownerSlashSkill]); // no @version -- resolves to latest again
    } catch (error) {
      // One skill being removed/yanked/unreachable must not stop every other
      // skill in the batch from updating.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to update ${ownerSlashSkill}: ${message}`);
      failures.push(ownerSlashSkill);
    }
  }

  if (failures.length > 0) {
    console.error(`${failures.length} of ${skillKeys.length} skill(s) failed to update: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}
