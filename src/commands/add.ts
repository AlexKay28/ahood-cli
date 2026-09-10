import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, rmdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import * as tarStream from "tar-stream";
import { gunzipSync } from "node:zlib";
import { apiFetch, apiJson, ApiError, sanitizeErrorMessage } from "../http.js";
import { LOCKFILE_PATH, parseOwnerSkillVersion, skillDir, agentPath, AGENTS_ROOT, MCP_CONFIG_PATH } from "../spec.js";
import {
  readLockfile,
  withLock,
  writeJsonFileAtomic,
  writeLockfileEntryVerifyingChecksum,
  LockfileChecksumConflictError,
  type LockEntry,
} from "../lockfile.js";
import { promptSecret } from "../secret-prompt.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill add <owner>/<skill>[@version]";
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

// Shared wording for the checksum-pin tamper-detection guard, used both by
// the early unlocked fast-fail check in add() and by the real,
// concurrency-safe enforcement at each write site below (ahood-cli#101).
function checksumConflictMessage(key: string, meta: VersionMeta, existing: LockEntry): string {
  return `Refusing to install ${key}@${meta.version}: its checksum (${meta.checksum_sha256}) does not match the one already pinned in the lockfile (${existing.checksum_sha256}) for this exact version. If you trust this change, remove ${key}'s lockfile entry first.`;
}

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
      kind?: "skill" | "agent" | "mcp";
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
        reject(new Error(`Refusing to extract unsafe archive entry: ${sanitizeForTerminal(header.name)}`));
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
// entry to disk the way extractFreshVersion does for skills. Exported so
// `diff.ts` can reuse the exact same in-memory single-file extraction to
// pull SKILL.md out of two downloaded version archives without ever writing
// either to disk (ahood-cli#88).
export async function extractSingleFileContent(buffer: Buffer, entryName: string): Promise<Buffer> {
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

// Every manifest field used below -- and every tar entry name extractTarGz
// quotes back in an error above -- reaches the terminal (an error message, or
// -- worse -- the text printed immediately before a masked secret prompt)
// but comes verbatim from a third-party-published archive: server-side
// validation only checks these are strings, not that they're free of
// control/escape characters. A malicious description could otherwise smuggle
// a terminal control sequence (cursor movement, line-clear) that repaints
// what the user sees at the exact moment they're about to type a credential.
// Strips C0/C1 control characters (including ESC, \x1b) and caps length so a
// single field can't also flood the terminal.
//
// Takes `unknown` rather than `string` because every caller's "string" is a
// declared type over an unchecked `as ServerManifest` cast of downloaded JSON,
// not a guarantee: calling .replace() directly on a `registry_type: 123` would
// turn a diagnosable message into the raw TypeError ahood-cli#121 removed from
// this same path (ahood-cli#122).
function sanitizeForTerminal(text: unknown): string {
  return String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 200);
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
  const manifestName = sanitizeForTerminal(manifest.name);
  if (manifest.packages && manifest.packages.length === 1) {
    const pkg = manifest.packages[0];
    if (pkg.registry_type !== "npm" || pkg.runtime_hint !== "npx") {
      throw new Error(
        `${manifestName}'s server.json uses registry_type "${sanitizeForTerminal(pkg.registry_type)}"/runtime_hint "${sanitizeForTerminal(pkg.runtime_hint)}", which this version of ahood does not know how to install (only npm+npx is supported).`,
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
  throw new Error(`${manifestName}'s server.json has neither a single 'packages' entry nor a single 'remotes' entry.`);
}

// A conflicting .mcp.json entry is summarized back to the user in the
// collision error below so they can identify what they'd be overwriting --
// but this entry is, by definition, one ahood did NOT write (that's what
// makes it a collision), so it's a hand-authored entry that routinely passes
// a credential as a CLI arg (e.g. `"args": ["-y", "@thing", "--api-key",
// "sk-live-..."]`) or in a URL query string (`"url": "https://host/sse?
// token=..."`) -- neither of which a small "env"/"headers"-keyed redaction
// allowlist would ever touch. Worse than a rare edge case: update.ts calls
// add() for every locked entry and prints caught error messages, so a leak
// here would fire on a routine `ahood skill update`, not just a rare manual
// re-add.
//
// So rather than trying to allowlist every place a secret might hide, this
// prints only structural information: the entry's top-level key names, its
// `command` (a package identifier, not a secret), the key names inside
// `env`/`headers` (so the user can see WHICH variable conflicts without its
// value), and the conflicting URL's hostname (never its full value, since
// query strings are a common place to find a token). No leaf string value
// from `args`, a header's value, an env var's value, or a URL's path/query
// is ever included.
function summarizeConflictingEntry(entry: unknown): string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return String(entry);
  const obj = entry as Record<string, unknown>;
  const parts: string[] = [`keys: ${Object.keys(obj).join(", ") || "(none)"}`];
  if (typeof obj.command === "string") parts.push(`command: ${obj.command}`);
  for (const key of ["env", "headers"] as const) {
    const value = obj[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parts.push(`${key} keys: ${Object.keys(value as Record<string, unknown>).join(", ")}`);
    }
  }
  if (typeof obj.url === "string") {
    try {
      parts.push(`url host: ${new URL(obj.url).hostname}`);
    } catch {
      // Not a parseable URL -- omit rather than risk printing something
      // sensitive verbatim.
    }
  }
  return parts.join("; ");
}

// Reads and validates .mcp.json's shape, defaulting to an empty config when
// the file doesn't exist yet. Guards `mcpServers` itself (not just the
// top-level object) against being missing, `null`, or an array: a bare
// `fileContents.mcpServers === undefined` check alone would let
// `"mcpServers": null` reach the collision check below as an unactionable
// raw TypeError, and would let `"mcpServers": []` pass the collision check
// silently (an array's numeric-index write is then dropped entirely by
// JSON.stringify), reporting a successful install that wrote nothing.
// Exported so remove.ts/update.ts can read the same validated shape when
// deciding whether it's safe to touch an mcp entry (ahood-cli#169).
export function readMcpConfig(): Record<string, unknown> {
  if (!existsSync(MCP_CONFIG_PATH)) return { mcpServers: {} };
  // Read and parse are separate try blocks so an I/O failure isn't reported
  // as a syntax error: EACCES/EISDIR/EMFILE used to surface as "is not valid
  // JSON" about a file that often parses fine, sending the user hunting for a
  // syntax error when the fix is chmod or removing a stray directory
  // (ahood-cli#117). No "-- fix or remove it" advice on this branch: the
  // remedy depends on the errno, Node's own message already names the code
  // and the path, and remove.ts deliberately quotes only the text before
  // " -- " (ahood-cli#115).
  let raw: string;
  try {
    raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${MCP_CONFIG_PATH} exists but could not be read: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MCP_CONFIG_PATH} exists but is not valid JSON -- fix or remove it before running this command.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${MCP_CONFIG_PATH} exists but its top level is not a JSON object.`);
  }
  const fileContents = parsed as Record<string, unknown>;
  if (fileContents.mcpServers === undefined) {
    fileContents.mcpServers = {};
  } else if (
    typeof fileContents.mcpServers !== "object" ||
    fileContents.mcpServers === null ||
    Array.isArray(fileContents.mcpServers)
  ) {
    throw new Error(
      `${MCP_CONFIG_PATH}'s "mcpServers" key exists but is not a JSON object -- fix or remove it before running this command.`,
    );
  }
  return fileContents;
}

// Keyed by ahood's own validated `skill` slug (SEGMENT_RE-checked in
// spec.ts), not the manifest's self-reported `name` field: two different
// published packages could easily share a generic internal name like
// "weather-server", and a JSON object key built from unvalidated manifest
// text is a footgun this sidesteps entirely by never using it as a key.
function assertNoCollision(fileContents: Record<string, unknown>, owner: string, skill: string): void {
  const mcpServers = fileContents.mcpServers as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(mcpServers, skill)) {
    throw new Error(
      `${MCP_CONFIG_PATH} already has an entry named "${skill}" (${summarizeConflictingEntry(mcpServers[skill])}).\n` +
        `Remove it manually first if you want to reinstall ${owner}/${skill}.`,
    );
  }
}

// Extracts server.json, validates its shape, and resolves every
// environment variable it declares (prompting only for secrets not already
// set in the shell) -- the part of installing an mcp entry that's identical
// whether this is a fresh `add` or an `update` moving an existing pin
// forward. Exported so update.ts's real mcp-update path (ahood-cli#169)
// re-resolves secrets the same way a fresh install does, instead of
// duplicating this parsing/prompting logic.
// `existingEnv` carries forward the secret values already sitting in the
// entry being updated, so a routine `ahood skill update` doesn't re-prompt
// for a credential the user has already supplied. Only ever passed by
// updateMcpEntry, and only from an entry whose fingerprint it has just
// verified -- i.e. proven to be ahood's own unmodified entry, not something
// hand-edited or written by another tool.
//
// `allowNonTtyPrompt` (default true, preserving `echo secret | ahood skill
// add ...` for a fresh install the user explicitly asked for) is false on
// the update path: `ahood skill update` with no arguments walks EVERY locked
// entry, so a prompt there is never something the caller aimed at. Left
// interactive, an unattended update would hang on an idle pipe with no
// timeout -- against this CLI's "must never hang" rule -- or, worse, silently
// bank the first line of unrelated piped input (`echo y | ahood skill
// update`) as the credential and fingerprint over it.
//
// `secretNames` comes back alongside the config because `env` also carries
// non-secret configuration now (ahood-cli#120): callers that need to know
// whether what they just wrote to disk is actually a credential can no longer
// infer it from `env` being non-empty.
export async function resolveMcpServerConfig(
  buffer: Buffer,
  options: { existingEnv?: Record<string, string>; allowNonTtyPrompt?: boolean } = {},
): Promise<{ manifest: ServerManifest; serverConfig: Record<string, unknown>; secretNames: string[] }> {
  const { existingEnv, allowNonTtyPrompt = true } = options;
  const content = await extractSingleFileContent(buffer, "server.json");
  // Guarded the same way readMcpConfig guards .mcp.json: an unguarded parse
  // surfaced a raw V8 SyntaxError with a stack instead of this CLI's usual
  // single-line error (ahood-cli#121). The parser's own message is dropped
  // rather than run through sanitizeForTerminal, because V8 quotes a snippet
  // of the offending source in it -- that source is third-party archive
  // content, and sanitizing would still paste it into the terminal, just
  // with its control characters flattened.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch {
    throw new Error(
      "The downloaded archive's server.json is not valid JSON -- this published version is malformed and cannot be installed.",
    );
  }
  // Checked before the cast because buildMcpServerConfig immediately reads
  // properties off the result: valid JSON that isn't an object (`[]`, `"x"`,
  // `3`, `null`) would otherwise reach it and surface as an unactionable raw
  // TypeError (ahood-cli#121). Deliberately stops at "is it an object" -- the
  // manifest's actual shape is buildMcpServerConfig's job just below, and a
  // second implementation of that check here would be free to drift from it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "The downloaded archive's server.json is valid JSON but its top level is not an object -- this published version is malformed and cannot be installed.",
    );
  }
  const manifest = parsed as ServerManifest;

  // Validate the manifest's shape (unsupported registry_type/runtime_hint,
  // or neither a single 'packages' nor a single 'remotes' entry) BEFORE
  // prompting for any secret -- an install/update that's going to be
  // refused anyway must not first cost the user a masked secret prompt.
  // buildMcpServerConfig is called here with an empty env purely to run its
  // validation/throw; the result is discarded and rebuilt below once
  // secretEnv is known.
  buildMcpServerConfig(manifest, {});

  const envVars = manifest.packages?.[0]?.environment_variables ?? [];
  const env: Record<string, string> = {};

  // Non-secret variables used to be skipped outright, so a server declaring
  // one installed into a config that could not start it, with no diagnostic
  // (ahood-cli#120). They're configuration, not credentials: read them from
  // the shell, but never prompt -- a prompt here would reintroduce exactly
  // the unattended-use hazard ahood-cli#169/0.8.2 removed from the update
  // path, and there is nothing to mask anyway.
  //
  // Resolved in a first pass, ahead of any masked prompt below, for the same
  // reason buildMcpServerConfig is dry-run above and assertNoCollision runs
  // before installMcpEntry's resolve: an install that's going to be refused
  // for a missing required variable must not first cost the user a secret
  // prompt.
  for (const variable of envVars) {
    if (variable.is_secret) continue;
    // Same truthiness rule as the secret branch below: an empty-string env
    // var reads as "not set" rather than installing an empty value.
    const fromEnv = process.env[variable.name];
    if (fromEnv) {
      env[variable.name] = fromEnv;
      continue;
    }
    // `is_required` was parsed and validated but never consulted at install
    // time (ahood-cli#120). Optional means optional -- install without it.
    // Required means the server cannot start without it, so refusing beats
    // writing a config that is broken in a way nothing reports.
    if (variable.is_required) {
      throw new Error(
        `${sanitizeForTerminal(variable.name)} is required by ${sanitizeForTerminal(manifest.name)} but is not set -- export ${sanitizeForTerminal(variable.name)} and re-run.`,
      );
    }
  }

  // Required-ness needs no separate check on the secret path: every branch
  // below either resolves a value or throws, so a required secret with
  // nothing to fall back on already fails loudly (the non-TTY guard) or is
  // supplied at the prompt (ahood-cli#120).
  const secretNames: string[] = [];
  for (const variable of envVars) {
    if (!variable.is_secret) continue;
    secretNames.push(variable.name);
    const fromEnv = process.env[variable.name];
    // Truthiness, not `!== undefined` -- matches credentials.ts's
    // resolveToken(), the precedent this feature was explicitly modeled on
    // (per the design spec), which uses `if (process.env.AHOOD_TOKEN)`
    // specifically so an empty-string env var falls through to the real
    // source instead of silently installing an empty secret.
    if (fromEnv) {
      env[variable.name] = fromEnv;
      continue;
    }
    // Ordered after the env var deliberately: exporting the variable stays
    // the way to rotate a credential during an update, rather than being
    // shadowed by the stale value already on disk. Deliberately not extended
    // to non-secret variables (ahood-cli#120): carrying a value forward from
    // .mcp.json is credential-preservation machinery, and a non-secret is
    // plain configuration that the shell should stay authoritative for.
    const carriedForward = existingEnv?.[variable.name];
    if (carriedForward) {
      env[variable.name] = carriedForward;
      continue;
    }
    if (!allowNonTtyPrompt && !process.stdin.isTTY) {
      throw new Error(
        `${sanitizeForTerminal(variable.name)} is required by ${sanitizeForTerminal(manifest.name)} but is not set, and there is no terminal to prompt on -- export ${sanitizeForTerminal(variable.name)} and re-run.`,
      );
    }
    env[variable.name] = await promptSecret(
      `${sanitizeForTerminal(variable.name)} (${sanitizeForTerminal(variable.description)}): `,
    );
  }

  const serverConfig = buildMcpServerConfig(manifest, env);
  return { manifest, serverConfig, secretNames };
}

// The plaintext-secret warning printed after a successful mcp install/update.
// Still derived from the config that actually landed on disk -- the property
// the old bare `serverConfig.env` check was chosen for -- but intersected with
// the manifest's declared secrets, because `env` now also holds non-secret
// configuration (ahood-cli#120) and would otherwise warn about credentials
// for a server that declares none.
function warnIfSecretsWereWritten(serverConfig: Record<string, unknown>, secretNames: string[]): void {
  const env = serverConfig.env as Record<string, string> | undefined;
  if (!env) return;
  if (!secretNames.some((name) => Object.prototype.hasOwnProperty.call(env, name))) return;
  console.warn(`WARNING: ${MCP_CONFIG_PATH} now contains one or more secret values in plaintext -- do not commit it to version control.`);
}

// Fingerprint of exactly what ahood wrote into .mcp.json's mcpServers.<skill>
// entry, stored in the lockfile alongside the version/checksum pin. Lets
// remove/update (ahood-cli#169) tell "the on-disk entry is still exactly
// what I last installed" from "something (the user, another tool) has since
// hand-edited it" -- without this, a real (not just warned-about) removal
// or update risks silently discarding an intentional local edit, the same
// class of risk assertNoCollision below exists to prevent on a *fresh*
// install. Hashes a canonical (recursively key-sorted) serialization rather
// than raw JSON.stringify output, because .mcp.json is shared with other MCP
// clients by design (see CLAUDE.md) and so gets rewritten by things that are
// not ahood -- `jq -S`, a format-on-save plugin, another client's serializer,
// a user retyping the block -- any of which can reorder keys without changing
// what the entry means. Fingerprinting insertion order turned every such
// reformat into a permanent refusal from both `update` and `remove`,
// recoverable only by hand-deleting the entry and re-entering its secret
// (ahood-cli#116). Arrays keep their order: `args` is order-significant.
export function hashMcpServerConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeForHash(config))).digest("hex");
}

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

// LEGACY (ahood-cli#116): the pre-canonicalization fingerprint format. Every
// mcp entry pinned by an older CLI carries one of these, so changing the
// algorithm without a fallback would invalidate all of them at once --
// inflicting the exact permanent-refusal failure #116 is about on every
// existing user, on upgrade. Only ever consulted as a second chance after the
// canonical hash misses; drop this function and matchesMcpConfigHash's
// fallback branch a few releases on.
function hashMcpServerConfigLegacy(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

// The single "is this on-disk entry still what we recorded?" decision, shared
// by every comparison site (updateMcpEntry's pre-check and its re-check under
// lock, remove's read and its re-check under lock). Centralized deliberately:
// a legacy fallback open-coded at four call sites is a fallback that ends up
// at three of them. A legacy match needs no separate signal to callers --
// update rewrites the pin with a canonical hash as part of its normal
// lockfile write, so such an entry self-heals silently on the next version
// bump, and remove is deleting the entry anyway.
export function matchesMcpConfigHash(entry: unknown, recordedHash: string): boolean {
  return hashMcpServerConfig(entry) === recordedHash || hashMcpServerConfigLegacy(entry) === recordedHash;
}

// Pulls the `env` map out of an .mcp.json entry read off disk, so an update
// can carry its secrets forward (see resolveMcpServerConfig's `existingEnv`).
// Written defensively -- the entry is `unknown` here, and only a string value
// is usable as a credential -- even though the caller has already fingerprint-
// verified it, so that a shape this function can't read degrades into a
// prompt rather than a crash.
function readMcpEntryEnv(entry: unknown): Record<string, string> | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const env = (entry as Record<string, unknown>).env;
  if (typeof env !== "object" || env === null) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

async function installMcpEntry(owner: string, skill: string, meta: VersionMeta, buffer: Buffer): Promise<void> {
  // Check for an existing .mcp.json collision BEFORE resolving secrets --
  // matches resolveMcpServerConfig's own "don't cost the user a prompt for
  // something that's going to be refused anyway" reasoning, just for the
  // collision check specifically rather than the manifest-shape check.
  assertNoCollision(readMcpConfig(), owner, skill);
  const { serverConfig, secretNames } = await resolveMcpServerConfig(buffer);

  // Read-modify-write under an advisory lock, mirroring lockfile.ts's own
  // writeLockfileEntry: .mcp.json sits right next to the lockfile and can
  // hold other servers' secrets, so it gets the same protection against a
  // truncated write or a concurrent `add` racing the same read-modify-write.
  // Re-reads and re-checks the collision here rather than trusting the
  // pre-check above, since arbitrary time may have passed since then --
  // including, in the interactive case, however long the user took at the
  // secret prompt -- during which another process could have written the
  // same entry.
  withLock(MCP_CONFIG_PATH, () => {
    const fileContents = readMcpConfig();
    assertNoCollision(fileContents, owner, skill);
    (fileContents.mcpServers as Record<string, unknown>)[skill] = serverConfig;
    writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
  });

  const mcpKey = `${owner}/${skill}`;
  try {
    writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, mcpKey, {
      version: meta.version,
      checksum_sha256: meta.checksum_sha256,
      mcp_config_hash: hashMcpServerConfig(serverConfig),
    });
  } catch (error) {
    if (!(error instanceof LockfileChecksumConflictError)) throw error;
    // Roll back the .mcp.json merge above under the same lock pattern --
    // re-read+delete rather than assuming nothing else changed it since.
    withLock(MCP_CONFIG_PATH, () => {
      const fileContents = readMcpConfig();
      delete (fileContents.mcpServers as Record<string, unknown>)[skill];
      writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
    });
    throw new Error(checksumConflictMessage(mcpKey, meta, error.existing));
  }
  console.log(`Installed ${owner}/${skill}@${meta.version} into ${MCP_CONFIG_PATH} as "${skill}"`);
  // Only the npm+npx package path ever carries secrets into `env` (headers
  // on a remote entry are static per v1's scope, per buildMcpServerConfig).
  warnIfSecretsWereWritten(serverConfig, secretNames);
}

// Re-runs the mcp install flow for an already-installed entry, moving its
// lockfile pin forward -- update.ts's real mcp-update path (ahood-cli#169).
// Unlike installMcpEntry, "the entry already exists" is expected here (it's
// the very entry being updated), so the safety check is inverted: rather
// than refusing because something's already there, this refuses UNLESS the
// on-disk entry's fingerprint still matches what was recorded at the last
// install/update -- same posture as assertNoCollision, applied to "is this
// still mine to touch" instead of "is this mine to create". If the entry is
// missing entirely, there's nothing to protect -- write fresh (self-heals a
// lockfile pin whose .mcp.json entry was deleted by hand without going
// through `ahood skill remove`). If it's present but doesn't match (or no
// fingerprint was ever recorded, e.g. an entry installed before this field
// existed), refuse rather than silently overwrite a possibly-intentional
// local edit.
export async function updateMcpEntry(owner: string, skill: string, meta: VersionMeta, currentEntry: LockEntry | undefined): Promise<void> {
  const key = `${owner}/${skill}`;
  const recordedHash = currentEntry?.mcp_config_hash;

  const fileContents = readMcpConfig();
  const mcpServers = fileContents.mcpServers as Record<string, unknown>;
  const existingOnDisk = Object.prototype.hasOwnProperty.call(mcpServers, skill) ? mcpServers[skill] : undefined;

  // Both refusal messages below point at manually editing .mcp.json, not
  // `ahood skill remove` -- remove refuses to delete an entry under
  // exactly these same two conditions (no recorded fingerprint, or a
  // fingerprint mismatch), so telling the user to "remove then add" would
  // send them into a sequence where remove leaves the entry in place *and*
  // clears the lockfile pin, and the follow-up add then fails on the very
  // same entry as a collision -- pin gone, credential still live, no CLI
  // path forward. Editing .mcp.json by hand and then running `add` is the
  // only sequence that actually resolves the state.
  if (existingOnDisk !== undefined) {
    if (recordedHash === undefined) {
      throw new Error(
        `Cannot verify ${key}'s .mcp.json entry matches what ahood last installed (no recorded fingerprint) -- delete the "${skill}" entry from mcpServers in .mcp.json by hand, then run \`ahood skill add ${key}\` to reinstall and enable automatic updates going forward.`,
      );
    }
    if (!matchesMcpConfigHash(existingOnDisk, recordedHash)) {
      throw new Error(
        `${key}'s .mcp.json entry appears to have been modified since install -- refusing to overwrite it. Delete the "${skill}" entry from mcpServers in .mcp.json by hand, then run \`ahood skill add ${key}\` to reinstall.`,
      );
    }
  }

  const buffer = await downloadVerifiedArchive(owner, skill, meta);
  // Reuse the secrets already in the entry rather than re-prompting for
  // them. Safe to trust specifically because the fingerprint check above has
  // just proven this is ahood's own unmodified entry; in the self-heal case
  // (no entry on disk at all) there's nothing to carry forward and a genuine
  // prompt is correct.
  const existingEnv = readMcpEntryEnv(existingOnDisk);
  const { serverConfig, secretNames } = await resolveMcpServerConfig(buffer, { existingEnv, allowNonTtyPrompt: false });

  // Read-modify-write under an advisory lock, mirroring installMcpEntry's
  // own pattern. Re-checks the fingerprint here too (not just above) since
  // arbitrary time may have passed since the pre-check -- the download, and
  // any secret prompt inside resolveMcpServerConfig -- during which another
  // process could have changed the entry.
  let previousOnDisk: unknown;
  withLock(MCP_CONFIG_PATH, () => {
    const fresh = readMcpConfig();
    const freshServers = fresh.mcpServers as Record<string, unknown>;
    const freshExisting = Object.prototype.hasOwnProperty.call(freshServers, skill) ? freshServers[skill] : undefined;
    if (freshExisting !== undefined && (recordedHash === undefined || !matchesMcpConfigHash(freshExisting, recordedHash))) {
      throw new Error(`${key}'s .mcp.json entry changed while updating -- refusing to overwrite it. Re-run \`ahood skill update ${key}\` if this was unexpected.`);
    }
    previousOnDisk = freshExisting;
    freshServers[skill] = serverConfig;
    writeJsonFileAtomic(MCP_CONFIG_PATH, fresh);
  });

  try {
    writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, key, {
      version: meta.version,
      checksum_sha256: meta.checksum_sha256,
      mcp_config_hash: hashMcpServerConfig(serverConfig),
    });
  } catch (error) {
    // Roll back the .mcp.json overwrite above under the same lock pattern,
    // restoring the entry to what it was before this update touched it --
    // not deleting it, unlike installMcpEntry's rollback: unless this was
    // the self-heal-a-missing-entry case (previousOnDisk undefined), there
    // WAS a working entry here before this update began.
    //
    // Runs for EVERY lockfile failure, not just a checksum conflict. A
    // rethrow-before-rollback here left .mcp.json holding the new config
    // while the lockfile kept the old version and old mcp_config_hash, after
    // which the fingerprint never matches again and both `update` and
    // `remove` permanently refuse -- the exact dead end the comments above
    // exist to prevent, reachable from nothing worse than withLock's 5s
    // timeout against a concurrent ahood, or an EACCES/ENOSPC on the write.
    try {
      withLock(MCP_CONFIG_PATH, () => {
        const fileContents = readMcpConfig();
        const mcpServers = fileContents.mcpServers as Record<string, unknown>;
        if (previousOnDisk === undefined) {
          delete mcpServers[skill];
        } else {
          mcpServers[skill] = previousOnDisk;
        }
        writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
      });
    } catch {
      // The rollback can fail for the same reason the write did (lock still
      // contended, disk still full). Warn rather than throw: the original
      // error below is the more actionable one, and masking it with this
      // one would hide why the update failed in the first place.
      console.warn(
        `WARNING: could not roll back ${MCP_CONFIG_PATH} after ${key}'s update failed -- its mcpServers."${skill}" entry may be on the new version while ${LOCKFILE_PATH} still pins the old one. Delete that entry by hand and run \`ahood skill add ${key}\` to reinstall.`,
      );
    }
    if (error instanceof LockfileChecksumConflictError) {
      throw new Error(checksumConflictMessage(key, meta, error.existing));
    }
    throw error;
  }

  console.log(`Updated ${key} to ${meta.version}`);
  warnIfSecretsWereWritten(serverConfig, secretNames);
}

// Downloads a specific version's archive and verifies it against the
// checksum in `meta`, WITHOUT extracting anything -- the shared first half
// of add()'s download flow below, pulled out so `diff.ts` (ahood-cli#88) can
// fetch two versions' archives the same verified way without duplicating
// the download/checksum logic.
export async function downloadVerifiedArchive(owner: string, skill: string, meta: VersionMeta): Promise<Buffer> {
  const downloadRes = await apiFetch(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/download?version=${encodeURIComponent(meta.version)}`,
    { headers: { "X-Ahood-Source": "cli" }, redirect: "follow" },
  );
  if (!downloadRes.ok) {
    // Same host as every other apiJson call, so this must throw ApiError
    // (not a plain Error) to get the right exitCodeFor mapping (401/404/5xx),
    // and route the body through sanitizeErrorMessage -- an unsanitized WAF/
    // proxy HTML page would otherwise dump straight to the terminal here,
    // exactly what that function exists to prevent elsewhere (ahood-cli#102).
    const rawBody = await downloadRes.text().catch(() => "");
    const body = rawBody ? sanitizeErrorMessage(rawBody) : "";
    throw new ApiError(downloadRes.status, `Download failed with status ${downloadRes.status}${body ? `: ${body}` : ""}`);
  }
  const buffer = await readBoundedBody(downloadRes, MAX_DOWNLOAD_BYTES);

  const actualChecksum = createHash("sha256").update(buffer).digest("hex");
  if (actualChecksum !== meta.checksum_sha256) {
    throw new Error(
      `Checksum mismatch for ${owner}/${skill}@${meta.version}: expected ${meta.checksum_sha256}, got ${actualChecksum}. Refusing to install.`,
    );
  }
  return buffer;
}

export async function add(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill, version: requestedVersion } = parseOwnerSkillVersion(spec, USAGE);
  const key = `${owner}/${skill}`;

  const meta = await fetchVersionMeta(owner, skill, requestedVersion);

  // A lockfile entry records the checksum this exact version was installed
  // with; if a later fetch of the "same" version disagrees, either the
  // published artifact changed after being pinned or the registry response
  // was tampered with in transit -- either way this is not something to
  // silently accept and overwrite. This early, UNLOCKED read is a fast-fail
  // optimization only (skip an entire download for the common, non-
  // concurrent case) -- it provides no real guarantee under concurrent
  // installs. The actual enforcement is the locked, read-check-write
  // writeLockfileEntryVerifyingChecksum call at each write site below
  // (ahood-cli#101).
  const existingEntry = readLockfile(LOCKFILE_PATH)[key];
  if (existingEntry && existingEntry.version === meta.version && existingEntry.checksum_sha256 !== meta.checksum_sha256) {
    throw new Error(checksumConflictMessage(key, meta, existingEntry));
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

  const buffer = await downloadVerifiedArchive(owner, skill, meta);

  if (meta.kind === "agent") {
    const content = await extractSingleFileContent(buffer, "AGENT.md");
    mkdirSync(AGENTS_ROOT, { recursive: true });
    const destPath = agentPath(owner, skill);
    writeFileSync(destPath, content);
    try {
      writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, key, { version: meta.version, checksum_sha256: meta.checksum_sha256 });
    } catch (error) {
      if (!(error instanceof LockfileChecksumConflictError)) throw error;
      rmSync(destPath, { force: true });
      throw new Error(checksumConflictMessage(key, meta, error.existing));
    }
    console.log(`Installed ${key}@${meta.version} to ${destPath}`);
    return;
  }

  if (meta.kind === "mcp") {
    await installMcpEntry(owner, skill, meta, buffer);
    return;
  }

  // Flat, owner@skill-joined directory name so Claude Code's own one-level-deep
  // project-skill scan actually discovers it (see skillDir's comment in spec.ts).
  const destDir = skillDir(owner, skill);
  await extractFreshVersion(buffer, destDir);
  try {
    writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, key, {
      version: meta.version,
      checksum_sha256: meta.checksum_sha256,
    });
  } catch (error) {
    if (!(error instanceof LockfileChecksumConflictError)) throw error;
    rmSync(destDir, { recursive: true, force: true });
    throw new Error(checksumConflictMessage(key, meta, error.existing));
  }

  console.log(`Installed ${key}@${meta.version} to ${destDir}`);
}
