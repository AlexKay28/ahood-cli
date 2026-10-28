import { unrecognizedArgs } from "../flags.js";
import { itemKey, migrateProjectLockfileOrWarn, readInstalled, updateInstalled, type InstalledItem } from "../installed.js";
import { parseOwnerSkill, SEMVER_RE } from "../spec.js";
import { UsageError } from "../usage-error.js";

const PIN_USAGE = "Usage: ahood pin <owner>/<slug>[@version] [--json]";
const UNPIN_USAGE = "Usage: ahood unpin <owner>/<slug> [--json]";

// `ahood pin` / `ahood unpin` (ahood#979): a pin holds every install of
// owner/slug at one version, recorded in ~/.ahood/installed.json. `ahood sync`
// never moves a pinned install past it (it moves one that is not on the
// pinned version yet TO it, with the same per-artifact consent), and
// `ahood status` shows it. Without @version the pin is the version installed now.

function parseArgs(args: string[], usage: string, allowVersion: boolean): { owner: string; slug: string; version?: string; json: boolean } {
  const positionals = unrecognizedArgs(args, ["--json"], []);
  const unknownFlag = positionals.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${usage}`);
  if (positionals.length !== 1) throw new UsageError(usage);
  const spec = positionals[0];
  const at = spec.lastIndexOf("@");
  const hasVersion = at > 0;
  if (hasVersion && !allowVersion) throw new UsageError(`unpin takes no version.\n${usage}`);
  const version = hasVersion ? spec.slice(at + 1) : undefined;
  if (version !== undefined && !SEMVER_RE.test(version)) {
    throw new UsageError(`Invalid version "${version}" in "${spec}" -- expected a semver like 1.2.3.\n${usage}`);
  }
  const { owner, skill } = parseOwnerSkill(hasVersion ? spec.slice(0, at) : spec, usage);
  return { owner, slug: skill, version, json: args.includes("--json") };
}

function installsOf(items: InstalledItem[], key: string): InstalledItem[] {
  return items.filter((i) => itemKey(i).toLowerCase() === key.toLowerCase());
}

function notInstalled(key: string): UsageError {
  return new UsageError(`${key} is not installed (per \`ahood status\`) -- install it first with \`ahood skill add ${key}\`.`);
}

export async function pin(args: string[]): Promise<void> {
  const { owner, slug, version, json } = parseArgs(args, PIN_USAGE, true);
  const key = `${owner}/${slug}`;
  migrateProjectLockfileOrWarn();
  if (installsOf(readInstalled().items, key).length === 0) throw notInstalled(key);
  const pinned = updateInstalled((file) =>
    installsOf(file.items, key).map((i) => {
      i.pinned = version ?? i.version;
      return { installed_path: i.installedPath, installed_version: i.version, pinned: i.pinned };
    }),
  );
  if (json) {
    console.log(JSON.stringify({ owner, slug, installs: pinned }));
    return;
  }
  for (const p of pinned) {
    const note = p.pinned === p.installed_version ? "" : ` (installed ${p.installed_version}; \`ahood sync\` will offer to move it)`;
    console.log(`Pinned ${key} at ${p.pinned}${note} -- ${p.installed_path}`);
  }
}

export async function unpin(args: string[]): Promise<void> {
  const { owner, slug, json } = parseArgs(args, UNPIN_USAGE, false);
  const key = `${owner}/${slug}`;
  migrateProjectLockfileOrWarn();
  if (installsOf(readInstalled().items, key).length === 0) throw notInstalled(key);
  const changed = updateInstalled((file) => {
    let n = 0;
    for (const i of installsOf(file.items, key)) {
      if (i.pinned !== undefined) n++;
      delete i.pinned;
    }
    return n;
  });
  if (json) {
    console.log(JSON.stringify({ owner, slug, unpinned: changed }));
    return;
  }
  console.log(changed > 0 ? `Unpinned ${key}; \`ahood sync\` will offer its latest version again.` : `${key} was not pinned.`);
}
