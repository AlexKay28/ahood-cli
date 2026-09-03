import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import * as tarStream from "tar-stream";
import { gunzipSync } from "node:zlib";
import { apiFetch, apiJson } from "../http.js";
import { LOCKFILE_PATH, parseOwnerSkillVersion, skillDir, agentPath, AGENTS_ROOT, MCP_CONFIG_PATH } from "../spec.js";
import { readLockfile, writeLockfileEntry } from "../lockfile.js";
import { promptSecret } from "../secret-prompt.js";

const USAGE = "Usage: ahood add <owner>/<skill>[@version]";
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB compressed
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024; // 200 MB decompressed
const MAX_ENTRY_COUNT = 10_000;

// `changelog_md` is optional/nullable here (rather than a plain `string`)
// because this type is shared with callers -- like `update --dry-run`'s
// preview -- that only ever read it, never require it: an older API
// response, or a version published before changelogs existed, may simply
// omit it, and that must degrade to "no changelog available" rather than a
// runtime crash.
export type VersionMeta = {
  version: string;
  manifest: Array<{ path: string }>;
  checksum_sha256: string;
  yanked_at: string | null;
  changelog_md?: string | null;
  kind?: "skill" | "agent" | "mcp";
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
export async function fetchVersionMeta(owner: string, skill: string, version: string): Promise<VersionMeta> {
  if (version === "latest") {
    // `kind` comes back as a TOP-LEVEL sibling of `skill_versions` on this
    // route (GET /api/v1/skills/{owner}/{skill}), not nested inside it --
    // confirmed against the real route.ts response shape. Destructuring only
    // `skill_versions` (as this used to do) silently drops `kind`, which
    // makes an agent install fall through to the skill-directory path with
    // no error anywhere (ahood-cli final review finding #1).
    const { skill_versions, kind } = await apiJson<{
      skill_versions: Omit<VersionMeta, "yanked_at" | "kind"> | null;
      kind?: "skill" | "agent";
    }>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`);
    if (!skill_versions) throw new Error(`${owner}/${skill} has no published version`);
    return { ...skill_versions, kind, yanked_at: null };
  }
  return apiJson<VersionMeta>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/${encodeURIComponent(version)}`,
  );
}

// Reads a fetch Response body while enforcing MAX_DOWNLOAD_BYTES AS bytes
// arrive, instead of buffering the whole thing via arrayBuffer() and checking
// afterwards (ahood-cli#37). A content-length header, when present and
// already over cap, lets us bail before reading a single byte; but the header
// is attacker/server-controlled and sometimes just absent (chunked transfer,
// a mutated/redirected presigned URL), so it's a fast-path optimization only
// -- the streaming check below is what actually bounds memory in every case.
async function readBoundedBody(res: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `Download is ${contentLength} bytes, over the ${maxBytes / (1024 * 1024)} MB limit -- refusing to install.`,
    );
  }
  if (!res.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  // Throwing out of a `for await` loop over a ReadableStream runs the async
  // iterator's implicit `return()`, which cancels the underlying stream and
  // releases its reader lock -- no separate res.body.cancel() call needed
  // (and calling one here would fail anyway: the stream is locked to this
  // loop's internal reader). This is what actually stops reading mid-download
  // rather than draining the rest of a huge/malicious body first.
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(
        `Downloaded archive is over the ${maxBytes / (1024 * 1024)} MB limit -- refusing to install.`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function extractTarGz(buffer: Buffer, destDir: string): Promise<void> {
  let decompressed: Buffer;
  try {
    // maxOutputLength caps decompression itself, so a highly-compressed
    // "bomb" (whose checksum otherwise matches, since that check runs on the
    // compressed bytes) can't exhaust memory -- it throws before the
    // oversized buffer is ever materialized.
    decompressed = gunzipSync(buffer, { maxOutputLength: MAX_EXTRACTED_BYTES });
  } catch (error) {
    throw new Error(
      `Archive decompresses to more than ${MAX_EXTRACTED_BYTES / (1024 * 1024)} MB, or is not valid gzip -- refusing to extract.`,
      { cause: error },
    );
  }

  const extract = tarStream.extract();
  const resolvedDest = resolve(destDir);
  let entryCount = 0;

  await new Promise<void>((resolvePromise, reject) => {
    extract.on("entry", (header, stream, next) => {
      entryCount++;
      if (entryCount > MAX_ENTRY_COUNT) {
        stream.resume();
        reject(new Error(`Archive has more than ${MAX_ENTRY_COUNT} entries -- refusing to extract.`));
        extract.destroy();
        return;
      }
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
        try {
          mkdirSync(join(fullPath, ".."), { recursive: true });
          // Preserve the tar entry's mode (e.g. a scripts/*.sh published with
          // its executable bit set) instead of always writing with the
          // default mode.
          writeFileSync(fullPath, Buffer.concat(chunks), header.mode ? { mode: header.mode } : undefined);
          next();
        } catch (error) {
          // Previously uncaught here -- an ENOSPC/EACCES/EROFS mid-extract
          // surfaced as a raw Node stack trace instead of the clean,
          // single-line error every other failure in this CLI produces.
          reject(error);
        }
      });
      stream.on("error", reject);
    });
    extract.on("finish", () => resolvePromise());
    extract.on("error", reject);
    extract.end(decompressed);
  });
}

// Extracts into a fresh temp directory next to destDir, then swaps it in.
// Extracting straight into destDir (the old behavior) only ever ADDED files
// on an upgrade -- anything removed in a newer version, including a script
// pulled for a security reason, silently stuck around. The temp+rename swap
// also means a failed/interrupted extract never leaves destDir half-upgraded.
async function extractFreshVersion(buffer: Buffer, destDir: string): Promise<void> {
  const parentDir = dirname(destDir);
  mkdirSync(parentDir, { recursive: true });
  const tempDir = join(parentDir, `.${basename(destDir)}.tmp-${process.pid}-${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  try {
    await extractTarGz(buffer, tempDir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    try {
      rmdirSync(parentDir);
    } catch {
      // parentDir wasn't empty (other skills from the same owner) -- fine.
    }
    throw error;
  }
  rmSync(destDir, { recursive: true, force: true });
  renameSync(tempDir, destDir);
}

// Agent packages install as one file, not a directory (Claude Code's own
// .claude/agents/*.md convention is flat, non-recursive) -- extracts just
// AGENT.md's content from the downloaded tarball rather than writing every
// entry to disk the way extractFreshVersion does for skills.
async function extractSingleFileContent(buffer: Buffer, entryName: string): Promise<Buffer> {
  let decompressed: Buffer;
  try {
    // Same decompression-bomb guard as extractTarGz above: a highly-
    // compressed payload whose checksum matches (that check runs on the
    // compressed bytes) must not be allowed to allocate unboundedly on
    // decompression.
    decompressed = gunzipSync(buffer, { maxOutputLength: MAX_EXTRACTED_BYTES });
  } catch (error) {
    throw new Error(
      `Archive decompresses to more than ${MAX_EXTRACTED_BYTES / (1024 * 1024)} MB, or is not valid gzip -- refusing to extract.`,
      { cause: error },
    );
  }
  const extract = tarStream.extract();
  let found: Buffer | null = null;
  await new Promise<void>((resolvePromise, reject) => {
    extract.on("entry", (header, stream, next) => {
      // Normalize a leading "./" the same way extractTarGz and the server's
      // extract-and-checksum.ts normalizeEntryPath do -- a plain `tar czf`
      // commonly prefixes entries with "./", which would otherwise pass
      // server-side validation/publish but then fail to install here with
      // "AGENT.md not found" (ahood-cli final review finding #3).
      const normalizedName = header.name.replace(/^\.\//, "");
      if (normalizedName !== entryName) {
        stream.resume();
        next();
        return;
      }
      // Only take the FIRST matching entry, mirroring the server side's
      // `files.find(...)` lookup -- otherwise a tar with two entries at the
      // same normalized name would resolve to whichever one happens to come
      // last here, diverging from what the server validated against
      // (ahood-cli final review finding #4).
      if (found !== null) {
        stream.resume();
        next();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(chunk as Buffer));
      stream.on("end", () => {
        found = Buffer.concat(chunks);
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", () => resolvePromise());
    extract.on("error", reject);
    extract.end(decompressed);
  });
  if (!found) throw new Error(`${entryName} not found in the downloaded archive`);
  return found;
}

type ServerManifestEnvVar = { name: string; description: string; is_required: boolean; is_secret: boolean };
type ServerManifestPackage = {
  registry_type: string;
  identifier: string;
  version: string;
  runtime_hint: string;
  environment_variables?: ServerManifestEnvVar[];
};
type ServerManifestRemote = { url: string; headers?: Record<string, string> };
type ServerManifest = {
  name: string;
  description: string;
  packages?: ServerManifestPackage[];
  remotes?: ServerManifestRemote[];
};

// Only npm+npx is supported in v1 (docs/superpowers/specs/2026-09-03-mcp-server-artifacts-design.md) --
// server-side publish validation (lib/publish/parse-server-manifest.ts) already
// rejects anything else, so this check is defense-in-depth against a
// manifest that somehow reached this point unvalidated, same posture as
// extractTarGz's own re-check of path containment "even though the server's
// publish-time validateEntries is supposed to have rejected it already."
function buildMcpServerConfig(manifest: ServerManifest, env: Record<string, string>): Record<string, unknown> {
  if (manifest.packages && manifest.packages.length === 1) {
    const pkg = manifest.packages[0];
    if (pkg.registry_type !== "npm" || pkg.runtime_hint !== "npx") {
      throw new Error(
        `${manifest.name}'s server.json uses registry_type "${pkg.registry_type}"/runtime_hint "${pkg.runtime_hint}", which this version of ahood does not know how to install (only npm+npx is supported).`,
      );
    }
    const config: Record<string, unknown> = { command: "npx", args: ["-y", `${pkg.identifier}@${pkg.version}`] };
    if (Object.keys(env).length > 0) config.env = env;
    return config;
  }
  if (manifest.remotes && manifest.remotes.length === 1) {
    const remote = manifest.remotes[0];
    return remote.headers ? { url: remote.url, headers: remote.headers } : { url: remote.url };
  }
  throw new Error(`${manifest.name}'s server.json has neither a single 'packages' entry nor a single 'remotes' entry.`);
}

// Keyed by ahood's own validated `skill` slug (SEGMENT_RE-checked in
// spec.ts), not the manifest's self-reported `name` field: two different
// published packages could easily share a generic internal name like
// "weather-server", and a JSON object key built from unvalidated manifest
// text is a footgun this sidesteps entirely by never using it as a key.
async function installMcpEntry(owner: string, skill: string, meta: VersionMeta, buffer: Buffer): Promise<void> {
  const content = await extractSingleFileContent(buffer, "server.json");
  const manifest = JSON.parse(content.toString("utf-8")) as ServerManifest;

  const envVars = manifest.packages?.[0]?.environment_variables ?? [];
  const secretEnv: Record<string, string> = {};
  for (const variable of envVars) {
    if (!variable.is_secret) continue;
    const fromEnv = process.env[variable.name];
    secretEnv[variable.name] =
      fromEnv !== undefined ? fromEnv : await promptSecret(`${variable.name} (${variable.description}): `);
  }

  const serverConfig = buildMcpServerConfig(manifest, secretEnv);

  let fileContents: Record<string, unknown> = { mcpServers: {} };
  if (existsSync(MCP_CONFIG_PATH)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
    } catch {
      throw new Error(`${MCP_CONFIG_PATH} exists but is not valid JSON -- fix or remove it before running this command.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${MCP_CONFIG_PATH} exists but its top level is not a JSON object.`);
    }
    fileContents = parsed as Record<string, unknown>;
    if (fileContents.mcpServers === undefined) fileContents.mcpServers = {};
  }
  const mcpServers = fileContents.mcpServers as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(mcpServers, skill)) {
    throw new Error(
      `${MCP_CONFIG_PATH} already has an entry named "${skill}":\n${JSON.stringify(mcpServers[skill], null, 2)}\n` +
        `Remove it manually first if you want to reinstall ${owner}/${skill}.`,
    );
  }
  mcpServers[skill] = serverConfig;
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(fileContents, null, 2));

  writeLockfileEntry(LOCKFILE_PATH, `${owner}/${skill}`, { version: meta.version, checksum_sha256: meta.checksum_sha256 });
  console.log(`Installed ${owner}/${skill}@${meta.version} into ${MCP_CONFIG_PATH} as "${skill}"`);
  if (Object.keys(secretEnv).length > 0) {
    console.warn(`WARNING: ${MCP_CONFIG_PATH} now contains one or more secret values in plaintext -- do not commit it to version control.`);
  }
}

export async function add(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error(USAGE);
  const { owner, skill, version: requestedVersion } = parseOwnerSkillVersion(spec, USAGE);
  const key = `${owner}/${skill}`;

  const meta = await fetchVersionMeta(owner, skill, requestedVersion);

  // A lockfile entry records the checksum this exact version was installed
  // with; if a later fetch of the "same" version disagrees, either the
  // published artifact changed after being pinned or the registry response
  // was tampered with in transit -- either way this is not something to
  // silently accept and overwrite.
  const existingEntry = readLockfile(LOCKFILE_PATH)[key];
  if (existingEntry && existingEntry.version === meta.version && existingEntry.checksum_sha256 !== meta.checksum_sha256) {
    throw new Error(
      `Refusing to install ${key}@${meta.version}: its checksum (${meta.checksum_sha256}) does not match the one already pinned in the lockfile (${existingEntry.checksum_sha256}) for this exact version. If you trust this change, remove ${key}'s lockfile entry first.`,
    );
  }

  if (meta.yanked_at) {
    console.warn(`WARNING: ${key}@${meta.version} has been yanked. Installing anyway.`);
  }
  // scripts/ warning: mirrors the web detail page's banner (platform ADR's
  // Open Risk #7) -- a CLI-only user installing via `add` would otherwise
  // never see this at all. Skipped for an agent install: only AGENT.md's
  // content is ever extracted/written on that path (extractSingleFileContent
  // never touches anything else in the archive), so a scripts/ entry in the
  // manifest can never actually land on disk there -- the warning would be
  // both mislabeled ("skill") and about a risk that can't materialize
  // (ahood-cli final review finding #5).
  if (meta.kind !== "agent" && meta.kind !== "mcp" && meta.manifest.some((f) => f.path.startsWith("scripts/"))) {
    console.warn("WARNING: this skill includes a scripts/ directory. Review its contents before use.");
  }

  const downloadRes = await apiFetch(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/download?version=${encodeURIComponent(meta.version)}`,
    { headers: { "X-Ahood-Source": "cli" }, redirect: "follow" },
  );
  if (!downloadRes.ok) {
    const body = await downloadRes.text().catch(() => "");
    throw new Error(`Download failed with status ${downloadRes.status}${body ? `: ${body}` : ""}`);
  }
  const buffer = await readBoundedBody(downloadRes, MAX_DOWNLOAD_BYTES);

  const actualChecksum = createHash("sha256").update(buffer).digest("hex");
  if (actualChecksum !== meta.checksum_sha256) {
    throw new Error(
      `Checksum mismatch for ${key}@${meta.version}: expected ${meta.checksum_sha256}, got ${actualChecksum}. Refusing to install.`,
    );
  }

  if (meta.kind === "agent") {
    const content = await extractSingleFileContent(buffer, "AGENT.md");
    mkdirSync(AGENTS_ROOT, { recursive: true });
    const destPath = agentPath(owner, skill);
    writeFileSync(destPath, content);
    writeLockfileEntry(LOCKFILE_PATH, key, { version: meta.version, checksum_sha256: meta.checksum_sha256 });
    console.log(`Installed ${key}@${meta.version} to ${destPath}`);
    return;
  }

  if (meta.kind === "mcp") {
    await installMcpEntry(owner, skill, meta, buffer);
    return;
  }

  // Owner-namespaced on disk, mirroring npm's node_modules/@scope/package.
  const destDir = skillDir(owner, skill);
  await extractFreshVersion(buffer, destDir);
  writeLockfileEntry(LOCKFILE_PATH, key, {
    version: meta.version,
    checksum_sha256: meta.checksum_sha256,
  });

  console.log(`Installed ${key}@${meta.version} to ${destDir}`);
}
