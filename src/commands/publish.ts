import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";
import { parseOwnerSkill, SEMVER_RE } from "../spec.js";

type InitResponse = { upload_url: string; storage_path: string; version_id: string };

const USAGE =
  "Usage: ahood publish <owner>/<skill>@<version> [--path <dir>]\n" +
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

function parsePublishArgs(args: string[]): { owner: string; skill: string; version: string; path: string } {
  const pathFlag = flagValue(args, "--path");
  let owner = flagValue(args, "--owner");
  let skill = flagValue(args, "--slug");
  let version = flagValue(args, "--version");
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
  return { owner, skill, version, path: pathFlag ?? legacyPath ?? "." };
}

export async function publish(args: string[]): Promise<void> {
  const { owner, skill, version, path } = parsePublishArgs(args);
  const skillMdPath = join(path, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found at ${skillMdPath} -- publish must point at a skill folder's root.`);
  }

  const archive = await tarGzDirectory(path);

  const init = await apiJson<InitResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/init`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, package_size_bytes: archive.length }),
    },
  );

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

  const complete = await apiJson<{ version: string; status: string }>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: init.version_id }),
    },
  );

  console.log(`Published ${owner}/${skill}@${complete.version} (${complete.status})`);
}
