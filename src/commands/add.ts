import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as tarStream from "tar-stream";
import { gunzipSync } from "node:zlib";
import { apiFetch, apiJson } from "../http.js";
import { writeLockfileEntry } from "../lockfile.js";

type VersionMeta = {
  version: string;
  manifest: Array<{ path: string }>;
  checksum_sha256: string;
  yanked_at: string | null;
};

// GET /api/v1/skills/{owner}/{skill}/versions/{version} matches the version
// string with an exact .eq() (verified live against this branch's route) --
// there is no "latest" literal in skill_versions.version, so requesting
// versions/latest 404s. Only the download endpoint has "latest" resolution
// built in. For metadata (which we need up front, to verify the checksum
// *before* trusting the download), we instead resolve "latest" through
// GET /api/v1/skills/{owner}/{skill}, whose `skill_versions` field is already
// joined against the skill's latest_version_id. That response has no
// yanked_at (latest_version_id isn't expected to ever point at a yanked
// version in this codebase), so the yanked-skill warning below only fires
// for an explicit @version -- confirmed by reading both route.ts files
// rather than assumed.
async function fetchVersionMeta(owner: string, skill: string, version: string): Promise<VersionMeta> {
  if (version === "latest") {
    const { skill_versions } = await apiJson<{ skill_versions: Omit<VersionMeta, "yanked_at"> | null }>(
      `/api/v1/skills/${owner}/${skill}`,
    );
    if (!skill_versions) throw new Error(`${owner}/${skill} has no published version`);
    return { ...skill_versions, yanked_at: null };
  }
  return apiJson<VersionMeta>(`/api/v1/skills/${owner}/${skill}/versions/${version}`);
}

function parseSpec(spec: string): { owner: string; skill: string; version: string } {
  const atIndex = spec.lastIndexOf("@");
  const ownerSkill = atIndex > 0 ? spec.slice(0, atIndex) : spec;
  const version = atIndex > 0 ? spec.slice(atIndex + 1) : "latest";
  const [owner, skill] = ownerSkill.split("/");
  if (!owner || !skill) throw new Error("Usage: ahood add <owner>/<skill>[@version]");
  return { owner, skill, version };
}

export async function extractTarGz(buffer: Buffer, destDir: string): Promise<void> {
  const tarBuffer = gunzipSync(buffer);
  const extract = tarStream.extract();
  const resolvedDest = resolve(destDir);
  await new Promise<void>((resolvePromise, reject) => {
    extract.on("entry", (header, stream, next) => {
      // Path containment, checked BEFORE anything is written. A tar entry
      // name is attacker-controlled data in an archive we merely downloaded
      // -- the server's publish-time validateEntries is supposed to have
      // rejected `..` already, but a client that extracts a remote archive
      // must not depend on a check it cannot see. resolve() collapses `..`
      // segments (and, on Windows, drive-absolute and backslash-separated
      // names) so the comparison catches every escape shape, not just a
      // literal leading "../".
      const entryPath = header.name.replace(/^\.\//, "");
      const fullPath = resolve(destDir, entryPath);
      if (fullPath !== resolvedDest && !fullPath.startsWith(resolvedDest + sep)) {
        stream.resume();
        reject(new Error(`Refusing to extract unsafe archive entry: ${header.name}`));
        // next() is deliberately NOT called -- nothing further in this archive
        // should be processed. destroy() tears the paused extractor down
        // rather than leaving it stalled mid-entry.
        extract.destroy();
        return;
      }
      if (header.type !== "file") {
        stream.resume();
        next();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(chunk as Buffer));
      stream.on("end", () => {
        mkdirSync(join(fullPath, ".."), { recursive: true });
        writeFileSync(fullPath, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", () => resolvePromise());
    extract.on("error", reject);
    extract.end(tarBuffer);
  });
}

export async function add(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error("Usage: ahood add <owner>/<skill>[@version]");
  const { owner, skill, version: requestedVersion } = parseSpec(spec);

  const meta = await fetchVersionMeta(owner, skill, requestedVersion);

  if (meta.yanked_at) {
    console.warn(`WARNING: ${owner}/${skill}@${meta.version} has been yanked. Installing anyway.`);
  }
  // scripts/ warning: mirrors the web detail page's banner (platform ADR's
  // Open Risk #7) -- a CLI-only user installing via `add` would otherwise
  // never see this at all.
  if (meta.manifest.some((f) => f.path.startsWith("scripts/"))) {
    console.warn("WARNING: this skill includes a scripts/ directory. Review its contents before use.");
  }

  const downloadRes = await apiFetch(`/api/v1/skills/${owner}/${skill}/download?version=${meta.version}`, {
    headers: { "X-Ahood-Source": "cli" },
    redirect: "follow",
  });
  if (!downloadRes.ok) throw new Error(`Download failed with status ${downloadRes.status}`);
  const buffer = Buffer.from(await downloadRes.arrayBuffer());

  const actualChecksum = createHash("sha256").update(buffer).digest("hex");
  if (actualChecksum !== meta.checksum_sha256) {
    throw new Error(
      `Checksum mismatch for ${owner}/${skill}@${meta.version}: expected ${meta.checksum_sha256}, got ${actualChecksum}. Refusing to install.`,
    );
  }

  // Owner-namespaced on disk, mirroring npm's node_modules/@scope/package.
  // Keyed on the slug alone, alice/utils and bob/utils were the same
  // directory: installing one silently overwrote the other's files, and
  // `remove` deleted whichever happened to be there. The lockfile key is
  // already "owner/skill" and needs no change.
  const destDir = join(".claude", "skills", owner, skill);
  await extractTarGz(buffer, destDir);
  writeLockfileEntry(join(".claude", "skills.lock.json"), `${owner}/${skill}`, {
    version: meta.version,
    checksum_sha256: meta.checksum_sha256,
  });

  console.log(`Installed ${owner}/${skill}@${meta.version} to ${destDir}`);
}
