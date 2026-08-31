import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { removeLockfileEntry } from "../lockfile.js";
import { LOCKFILE_PATH, parseOwnerSkill, skillDir } from "../spec.js";

const USAGE = "Usage: ahood remove <owner>/<skill>";

export async function remove(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  const key = `${owner}/${skill}`;

  const dir = skillDir(owner, skill);
  const dirExisted = existsSync(dir);
  if (dirExisted) rmSync(dir, { recursive: true, force: true });

  // Sweep the owner directory once it holds nothing, so uninstalling an
  // owner's last skill doesn't leave an empty namespace folder behind (npm
  // does the same with node_modules/@scope). Guarded on emptiness, so another
  // skill by the same owner is never touched.
  const ownerDir = dirname(dir);
  if (existsSync(ownerDir) && readdirSync(ownerDir).length === 0) rmdirSync(ownerDir);

  const hadLockfileEntry = removeLockfileEntry(LOCKFILE_PATH, key);

  if (!dirExisted && !hadLockfileEntry) {
    console.error(`${key} was not installed -- nothing to remove.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Removed ${key}`);
}
