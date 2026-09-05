import { createPatch } from "diff";
import { fetchVersionMeta, downloadVerifiedArchive, extractSingleFileContent, type VersionMeta } from "./add.js";
import { parseOwnerSkill, SEMVER_RE } from "../spec.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill diff <owner>/<skill> <versionA> <versionB> [--json]";

// Both versions must be explicit semver here, unlike `add`'s
// parseOwnerSkillVersion which lets "latest" default the version -- a diff
// is meaningless without two concrete, unambiguous versions to compare, and
// "latest" would silently mean two different things if the registry gained
// a new version between resolving vA and vB.
function validateVersion(version: string, spec: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new UsageError(`Invalid version "${version}" in "${spec}" -- expected a semver like 1.2.3.\n${USAGE}`);
  }
}

// Extracts SKILL.md's content from a downloaded version archive. Unlike an
// agent's AGENT.md (always present, since that's the only file an agent
// package ever installs), a skill package could in principle omit
// SKILL.md's presence from the manifest we already fetched -- checked
// up front so a missing file produces a clean message instead of
// extractSingleFileContent's generic "not found in the downloaded archive".
async function fetchSkillMdContent(owner: string, skill: string, meta: VersionMeta): Promise<string> {
  if (!meta.manifest.some((f) => f.path === "SKILL.md" || f.path === "./SKILL.md")) {
    throw new Error(`${owner}/${skill}@${meta.version} has no SKILL.md in its manifest.`);
  }
  const buffer = await downloadVerifiedArchive(owner, skill, meta);
  const content = await extractSingleFileContent(buffer, "SKILL.md");
  return content.toString("utf-8");
}

export type ManifestDiff = { added: string[]; removed: string[]; changed: string[] };

// Compares two versions' manifests by path. VersionMeta.manifest only
// carries `{path}` (no per-file size or checksum), so "added"/"removed" are
// fully determined by path presence, but "changed" can only be reported for
// SKILL.md itself (the one file whose content we've already downloaded and
// diffed above) -- there is no way to tell whether some other common path's
// *content* differs without downloading and comparing it too, which is out
// of scope for this command (see the resolution-plan comment on issue #88).
function diffManifests(
  manifestA: VersionMeta["manifest"],
  manifestB: VersionMeta["manifest"],
  skillMdChanged: boolean,
): ManifestDiff {
  const pathsA = new Set(manifestA.map((f) => f.path));
  const pathsB = new Set(manifestB.map((f) => f.path));
  const added = [...pathsB].filter((p) => !pathsA.has(p)).sort();
  const removed = [...pathsA].filter((p) => !pathsB.has(p)).sort();
  const changed: string[] = [];
  if (skillMdChanged && pathsA.has("SKILL.md") && pathsB.has("SKILL.md")) {
    changed.push("SKILL.md");
  }
  return { added, removed, changed };
}

export async function diff(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [spec, versionA, versionB] = positional;
  if (!spec || !versionA || !versionB) throw new UsageError(USAGE);

  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  validateVersion(versionA, `${spec} ${versionA}`);
  validateVersion(versionB, `${spec} ${versionB}`);

  const [metaA, metaB] = await Promise.all([
    fetchVersionMeta(owner, skill, versionA),
    fetchVersionMeta(owner, skill, versionB),
  ]);

  const [contentA, contentB] = await Promise.all([
    fetchSkillMdContent(owner, skill, metaA),
    fetchSkillMdContent(owner, skill, metaB),
  ]);

  const skillmdDiff = createPatch("SKILL.md", contentA, contentB, versionA, versionB);
  const skillMdChanged = contentA !== contentB;
  const manifest = diffManifests(metaA.manifest, metaB.manifest, skillMdChanged);

  if (jsonOutput) {
    console.log(JSON.stringify({ skillmd_diff: skillMdChanged ? skillmdDiff : "", manifest }));
    return;
  }

  console.log(`${owner}/${skill}: ${versionA} -> ${versionB}`);
  console.log("");
  if (skillMdChanged) {
    console.log(skillmdDiff);
  } else {
    console.log("SKILL.md is unchanged between these versions.");
  }

  const summaryParts: string[] = [];
  if (manifest.added.length > 0) summaryParts.push(`Files added: ${manifest.added.join(", ")}`);
  if (manifest.removed.length > 0) summaryParts.push(`Files removed: ${manifest.removed.join(", ")}`);
  if (manifest.changed.length > 0) summaryParts.push(`Files changed: ${manifest.changed.join(", ")}`);
  if (summaryParts.length > 0) {
    console.log("");
    for (const line of summaryParts) console.log(line);
  }
}
