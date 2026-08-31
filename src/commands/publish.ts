import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { apiJson, ApiError } from "../http.js";
import { flagValue } from "../flags.js";
import { parseOwnerSkill, SEMVER_RE } from "../spec.js";

type InitResponse = { upload_url: string; storage_path: string; version_id: string };
type CreateResponse = { id: string; slug: string; owner: string };
type VersionStatusResponse = { version: string; status: string; failure_reason?: string | null };

// Processing (decompress/validate/checksum/scan/upload) now happens in a
// background workflow, not inline in versions/complete's response (server
// issue #120) -- complete returns 202 immediately, so this polls
// GET .../versions/{version} (which now returns {status, failure_reason}
// even for a non-published row) until the version leaves 'processing'.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollVersionStatus(owner: string, skill: string, version: string): Promise<VersionStatusResponse> {
  const path = `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/${encodeURIComponent(version)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await apiJson<VersionStatusResponse>(path);
    if (result.status !== "processing") return result;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Still processing after ${POLL_TIMEOUT_MS / 1000}s -- check \`ahood view ${owner}/${skill}\` later for the result.`,
  );
}

const USAGE =
  "Usage: ahood publish <owner>/<skill>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>]\n" +
  "   or: ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>";

// Matched by ENTRY NAME at every depth, not by path prefix, so a nested
// `vendor/thing/.git` is skipped the same as a top-level one. Not a
// .gitignore parser (out of scope) -- just the fixed set of names that must
// never end up in a published archive:
//   .git      -- .git/config routinely carries a remote URL with embedded
//                credentials (https://user:ghp_xxx@github.com/...), which the
//                server-side secret scanner's regexes (AKIA, PEM headers,
//                32+ hex) do not match.
//   node_modules -- never part of a skill, and megabytes of it.
//   .env / .env.* -- the single most likely place a real secret lives.
//   .npmrc / .yarnrc.yml / .netrc / .pypirc -- package-manager/network auth
//                tokens (npm_..., ghp_...) that don't match the server
//                scanner's regexes either.
//   id_rsa / id_ed25519 / id_ecdsa / id_dsa (+ .pub) / .ssh -- SSH keys.
//   .aws / .docker -- cloud and registry credentials.
//   .DS_Store -- noise.
const EXCLUDED_NAMES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".npmrc",
  ".yarnrc.yml",
  ".netrc",
  ".pypirc",
  ".ssh",
  ".aws",
  ".docker",
]);
const EXCLUDED_PREFIXES = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
}

async function tarGzDirectory(dir: string): Promise<Buffer> {
  const tar = pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];

  function addDir(current: string, prefix: string) {
    for (const entry of readdirSync(current)) {
      if (isExcluded(entry)) continue;
      const fullPath = join(current, entry);
      const relPath = prefix ? `${prefix}/${entry}` : entry;
      // lstat, not stat -- following a symlink here would pack whatever it
      // points at (anywhere on disk, or a parent directory causing unbounded
      // recursion) under an innocuous-looking name, completely bypassing the
      // exclusion list above, which only ever matches by name.
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        console.warn(`WARNING: skipping symlink, not publishing it: ${relPath}`);
        continue;
      }
      if (stat.isDirectory()) {
        addDir(fullPath, relPath);
      } else if (stat.isFile()) {
        tar.entry({ name: relPath, size: stat.size }, readFileSync(fullPath));
      }
    }
  }

  addDir(dir, "");
  tar.finalize();

  return new Promise((resolve, reject) => {
    gzip.on("data", (chunk) => chunks.push(chunk as Buffer));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    tar.pipe(gzip);
  });
}

function parsePublishArgs(args: string[]): {
  owner: string;
  skill: string;
  version: string;
  path: string;
  name?: string;
  tagline?: string;
  tags?: string;
  license?: string;
} {
  const pathFlag = flagValue(args, "--path");
  let owner = flagValue(args, "--owner");
  let skill = flagValue(args, "--slug");
  let version = flagValue(args, "--version");
  const name = flagValue(args, "--name");
  const tagline = flagValue(args, "--tagline");
  const tags = flagValue(args, "--tags");
  const license = flagValue(args, "--license");
  let legacyPath: string | undefined;

  const first = args[0];
  if (first && !first.startsWith("--")) {
    if (first.includes("/") && first.includes("@")) {
      // Primary form: ahood publish <owner>/<skill>@<version>
      const parsed = parseOwnerSkill(first.slice(0, first.lastIndexOf("@")), USAGE);
      owner = owner ?? parsed.owner;
      skill = skill ?? parsed.skill;
      version = version ?? first.slice(first.lastIndexOf("@") + 1);
    } else {
      // Legacy form: ahood publish <path> --owner ... --slug ... --version ...
      legacyPath = first;
    }
  }

  if (!owner || !skill || !version) throw new Error(USAGE);
  if (!SEMVER_RE.test(version)) {
    throw new Error(`--version must be a semver like 1.2.3 (got "${version}").\n${USAGE}`);
  }
  return { owner, skill, version, path: pathFlag ?? legacyPath ?? ".", name, tagline, tags, license };
}

// Creates the skill under the caller's own account when versions/init 404s
// -- skill creation is CLI-only now (there is no separate `ahood create`;
// publish creates on first use). --name is required for this path since
// createSkill requires a name; --tagline/--tags/--license are optional and
// only used here, never applied to an already-existing skill.
async function createSkillForPublish(
  owner: string,
  skill: string,
  opts: { name?: string; tagline?: string; tags?: string; license?: string },
): Promise<void> {
  if (!opts.name) {
    throw new Error(
      `${owner}/${skill} doesn't exist yet -- pass --name to create it as part of this publish (e.g. --name "My Skill").`,
    );
  }
  const body: Record<string, unknown> = { slug: skill, name: opts.name };
  if (opts.tagline !== undefined) body.tagline = opts.tagline;
  if (opts.tags !== undefined) body.tags = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (opts.license !== undefined) body.license = opts.license;

  const created = await apiJson<CreateResponse>("/api/v1/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // POST /api/v1/skills always creates under the authenticated caller's own
  // account -- it never reads an owner from the request body. If the caller
  // typed a different owner segment than their own username, the created
  // skill lives at a path that doesn't match what they asked to publish to.
  if (created.owner !== owner) {
    throw new Error(
      `Created ${created.owner}/${created.slug}, but this publish targeted "${owner}/${skill}" -- skills ` +
        `are always created under your own account (${created.owner}). Retry with: ` +
        `ahood publish ${created.owner}/${skill}@<version>.`,
    );
  }
  console.log(`Created ${created.owner}/${created.slug} -- publishing its first version now.`);
}

async function initVersion(
  owner: string,
  skill: string,
  version: string,
  packageSizeBytes: number,
  createOpts: { name?: string; tagline?: string; tags?: string; license?: string },
): Promise<InitResponse> {
  const path = `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/init`;
  const body = JSON.stringify({ version, package_size_bytes: packageSizeBytes });
  try {
    return await apiJson<InitResponse>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    await createSkillForPublish(owner, skill, createOpts);
    // Retry exactly once. If this ALSO 404s (e.g. a race, or the create
    // silently didn't take), let that error propagate rather than looping.
    return await apiJson<InitResponse>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  }
}

export async function publish(args: string[]): Promise<void> {
  const { owner, skill, version, path, name, tagline, tags, license } = parsePublishArgs(args);
  const skillMdPath = join(path, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found at ${skillMdPath} -- publish must point at a skill folder's root.`);
  }

  const archive = await tarGzDirectory(path);

  const init = await initVersion(owner, skill, version, archive.length, { name, tagline, tags, license });

  // TS's lib.dom BodyInit (in scope here since tsconfig has no explicit
  // "lib" override, so DOM is included alongside the Node types) type-checks
  // Buffer/Uint8Array against `Uint8Array<ArrayBuffer>` specifically as of
  // TS 5.7+'s ArrayBufferLike generics, which a Node Buffer's
  // `Uint8Array<ArrayBufferLike>` doesn't structurally satisfy even though
  // it is a valid BufferSource at runtime (this is exactly what Node's own
  // fetch/undici accepts) -- see undici-types' BodyInit, which includes
  // `NodeJS.ArrayBufferView` (i.e. Buffer) directly with no such
  // restriction. Asserting through BodyInit here, rather than reshaping
  // tsconfig's "lib" for the whole package, keeps this fix local to the one
  // call site.
  const putRes = await fetch(init.upload_url, {
    method: "PUT",
    body: archive as unknown as BodyInit,
    signal: AbortSignal.timeout(120_000),
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(
      `Upload failed with status ${putRes.status}${body ? `: ${body}` : ""} (version_id: ${init.version_id}, retry with the same command once the underlying issue is fixed).`,
    );
  }

  await apiJson<{ version_id: string; version: string; status: string }>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: init.version_id }),
    },
  );

  console.log(`Uploaded ${owner}/${skill}@${version} -- processing...`);
  const result = await pollVersionStatus(owner, skill, version);
  if (result.status === "failed") {
    throw new Error(`Publish failed: ${result.failure_reason ?? "unknown reason"}`);
  }
  console.log(`Published ${owner}/${skill}@${result.version} (${result.status})`);
}
