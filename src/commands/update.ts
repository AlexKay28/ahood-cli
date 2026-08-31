import { LOCKFILE_PATH } from "../spec.js";
import { readLockfile } from "../lockfile.js";
import { add } from "./add.js";

// `update` is the only command that moves the lockfile pin forward -- `add`
// always resolves and pins whatever version it's given (or latest, once,
// at install time), matching the ADR's "reproducible by default" design.
export async function update(args: string[]): Promise<void> {
  const lockfile = readLockfile(LOCKFILE_PATH);
  const targets = args.length > 0 ? args : Object.keys(lockfile);
  if (targets.length === 0) {
    console.log("No installed skills to update.");
    return;
  }

  const failures: string[] = [];
  for (const ownerSlashSkill of targets) {
    if (!lockfile[ownerSlashSkill] && args.length === 0) {
      // Only reachable when targets came from the lockfile itself, so this
      // would mean the lockfile changed under us mid-loop -- skip, don't abort.
      console.warn(`Skipping ${ownerSlashSkill}: not currently installed.`);
      continue;
    }
    try {
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
    console.error(`${failures.length} of ${targets.length} skill(s) failed to update: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}
