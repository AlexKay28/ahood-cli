import { readLockfile } from "../lockfile.js";
import { add } from "./add.js";

// `update` is the only command that moves the lockfile pin forward -- `add`
// always resolves and pins whatever version it's given (or latest, once,
// at install time), matching the ADR's "reproducible by default" design.
export async function update(args: string[]): Promise<void> {
  const lockfile = readLockfile(".claude/skills.lock.json");
  const targets = args.length > 0 ? args : Object.keys(lockfile);
  if (targets.length === 0) {
    console.log("No installed skills to update.");
    return;
  }
  for (const ownerSlashSkill of targets) {
    if (!lockfile[ownerSlashSkill]) {
      console.warn(`Skipping ${ownerSlashSkill}: not currently installed.`);
      continue;
    }
    await add([ownerSlashSkill]); // no @version -- resolves to latest again
  }
}
