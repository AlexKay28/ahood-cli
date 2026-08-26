import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { removeLockfileEntry } from "../lockfile.js";

export async function remove(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error("Usage: skillhub remove <owner>/<skill>");
  const [, skill] = spec.split("/");
  if (!skill) throw new Error("Usage: skillhub remove <owner>/<skill>");

  const dir = join(".claude", "skills", skill);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  removeLockfileEntry(join(".claude", "skills.lock.json"), spec);
  console.log(`Removed ${spec}`);
}
