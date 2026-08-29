import { rmSync, rmdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { removeLockfileEntry } from "../lockfile.js";

export async function remove(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error("Usage: ahood remove <owner>/<skill>");
  const [owner, skill] = spec.split("/");
  if (!owner || !skill) throw new Error("Usage: ahood remove <owner>/<skill>");

  // Must mirror add.ts's owner-namespaced destDir exactly -- keyed on the
  // slug alone, `remove bob/utils` deleted alice/utils' files.
  const dir = join(".claude", "skills", owner, skill);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  // Sweep the owner directory once it holds nothing, so uninstalling an
  // owner's last skill doesn't leave an empty namespace folder behind (npm
  // does the same with node_modules/@scope). Guarded on emptiness, so another
  // skill by the same owner is never touched.
  const ownerDir = join(".claude", "skills", owner);
  if (existsSync(ownerDir) && readdirSync(ownerDir).length === 0) rmdirSync(ownerDir);

  removeLockfileEntry(join(".claude", "skills.lock.json"), spec);
  console.log(`Removed ${spec}`);
}
