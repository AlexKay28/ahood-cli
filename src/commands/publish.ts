import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { apiJson, ApiError, sanitizeErrorMessage } from "../http.js";
import { parseArgs } from "../flags.js";
import { usageLine } from "../help.js";
import { confirmYesNo, isInteractive } from "../confirm.js";
import { parseOwnerSkill, SEMVER_RE, validateExternalUrl } from "../spec.js";
import { UsageError } from "../usage-error.js";
import { assertKind, CLI_KINDS, isCliKind, KINDS, strictKind, type CliKind, type KindScope } from "../kinds.js";
import { parsePromptDoc } from "../prompt-doc.js";
import { stripProvenanceHeader } from "../provenance-header.js";

// `ahood agent publish` / `ahood mcp publish` (ahood-cli#172): an existing
// entry of another kind must be refused before anything is packed, created,
// or uploaded. The upload would fail server-side anyway -- the processing
// workflow validates the archive against the entry's stored kind -- but only
// after a version row was created and a full upload spent. A 404 is the
// "doesn't exist yet" case publish already handles by creating the entry,
// now with the scope's kind.
async function assertPublishTargetKind(scope: KindScope, owner: string, skill: string): Promise<void> {
  let detail: { kind?: unknown };
  try {
    detail = await apiJson<{ kind?: unknown }>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
  assertKind(scope, `${owner}/${skill}`, detail.kind, "publish", "publish a new version of");
}

type Visibility = "public" | "private";
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
    `Still processing after ${POLL_TIMEOUT_MS / 1000}s -- check \`ahood skill view ${owner}/${skill}\` later for the result.`,
  );
}

// The legacy `or:` form carries the same noun and per-kind placeholder as the
// primary line, both read from help.ts (ahood-cli#280).
function publishUsage(scope?: KindScope): string {
  const noun = scope?.noun ?? "skill";
  const primary = usageLine(noun, "publish");
  const placeholder = /<owner>\/<([^>]+)>@/.exec(primary)?.[1] ?? "skill";
  return `${primary}
   or: ahood ${noun} publish <path> --owner <owner> --slug <${placeholder}> --version <x.y.z> [--json]`;
}

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
//   .envrc    -- direnv's own file, commonly holding `export`ed secrets,
//                exact-matched (not a `.env` prefix match -- "rc" makes it a
//                distinct name, not a `.env.*` variant) since it doesn't
//                match the server scanner's regexes either (ahood-cli#97).
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
  ".envrc",
  ".ssh",
  ".aws",
  ".docker",
]);
const EXCLUDED_PREFIXES = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}.`));
}

// ahood-cli#93: in registry-first usage (an agent consuming this skill via
// the MCP server/registry, with no local SKILL.md ever loaded) the
// frontmatter `description` is the *only* signal an agent sees to decide
// whether to trigger this skill at all. A missing, oversized, or
// malformed-enough-to-mis-parse description means the skill silently never
// fires, and nothing today tells the author. This is a best-effort, targeted
// text scan -- not a real YAML parser (see init.ts's comment above
// buildSkillMd for why this codebase doesn't carry one) -- so it only needs
// to catch what a real skill author would plausibly write, not every legal
// YAML shape for `description:`.
const MAX_DESCRIPTION_LENGTH = 1024;

// Pulls just the `description:` value out of a SKILL.md's `---`-delimited
// frontmatter block. Returns undefined when the frontmatter or the key
// itself can't be found -- callers treat that the same as an empty
// description rather than throwing, since this scan is advisory only.
function extractSkillDescription(skillMd: string): { value: string; rawMultiLine: boolean } | undefined {
  const frontmatterMatch = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) return undefined;
  const lines = frontmatterMatch[1].split(/\r?\n/);

  const descIndex = lines.findIndex((line) => /^description:/.test(line));
  if (descIndex === -1) return undefined;
  const firstLineValue = lines[descIndex].slice("description:".length).trim();

  // YAML block scalar ("description: >" folded, or "description: |"
  // literal), optionally with a chomping/indentation indicator like ">-" or
  // "|2". Everything indented under it, until a dedented or blank line, is
  // the value -- this is the *correct* way to write a genuinely multi-line
  // description, so it does not trip the rawMultiLine heuristic below.
  const blockScalarMatch = firstLineValue.match(/^([>|])[+-]?\d*$/);
  if (blockScalarMatch) {
    const folded = blockScalarMatch[1] === ">";
    const collected: string[] = [];
    for (let i = descIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") {
        collected.push("");
        continue;
      }
      if (!/^\s/.test(line)) break; // dedented back to frontmatter's top level -- block scalar is over
      collected.push(line.trim());
    }
    const value = folded ? collected.filter(Boolean).join(" ") : collected.join("\n");
    return { value, rawMultiLine: false };
  }

  // Plain (or quoted) single-line form. Strip a matching pair of wrapping
  // quotes for the length/character checks below -- not a full YAML string
  // unescape, just enough to not count the quote characters themselves.
  let value = firstLineValue;
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }

  // Heuristic for "the author typed real newlines into what should be one
  // value": any non-blank line right after the description line that isn't
  // itself a new top-level `key:` entry. Depending on its indentation, real
  // YAML either folds this into the same scalar or fails to parse outright --
  // neither is what a naive frontmatter-reading agent gets right, so either
  // way it's worth flagging. This can't distinguish every edge case (e.g. a
  // value that legitimately continues a nested structure), but skill
  // frontmatter in practice is flat enough that it doesn't need to.
  let rawMultiLine = false;
  const extraLines: string[] = [];
  for (let i = descIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    if (!/^\s/.test(line) && /^[^\s:]+:/.test(line)) break; // next top-level key -- description's value ended
    rawMultiLine = true;
    extraLines.push(line.trim());
  }
  if (extraLines.length > 0) value = [value, ...extraLines].filter(Boolean).join(" ");

  return { value, rawMultiLine };
}

// Non-blocking: this only ever calls console.warn (never sets
// process.exitCode, never throws) so a weak description warns the author
// without affecting the exit code or --json mode's structured stdout output.
function warnAboutSkillDescription(skillMdPath: string): void {
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf8");
  } catch {
    return; // publish's own existsSync check already guards this path being missing entirely
  }

  const extracted = extractSkillDescription(content);
  const value = extracted?.value ?? "";

  if (!value.trim()) {
    console.warn(
      `WARNING: ${skillMdPath} has no (or an empty) description. In registry-first usage (an agent pulling this skill via the registry/MCP server, without ever loading this file) the description is the only signal deciding whether the skill is ever triggered -- without one, it effectively never will be.`,
    );
    return;
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    console.warn(
      `WARNING: ${skillMdPath}'s description is ${value.length} characters, over the ${MAX_DESCRIPTION_LENGTH}-character recommended cap. An oversized description crowds out an agent's other context and is less likely to be read in full when it's deciding whether to trigger this skill.`,
    );
  }
  if (extracted?.rawMultiLine) {
    console.warn(
      `WARNING: ${skillMdPath}'s description spans multiple raw lines without a YAML block-scalar indicator (">" or "|"). This is easy to write by accident and breaks simple frontmatter parsers that only read a single line -- keep the description on one line, or use an explicit ">" (folded) or "|" (literal) block scalar if it genuinely needs to span multiple lines.`,
    );
  }
  if (value.includes("<") || value.includes(">")) {
    console.warn(
      `WARNING: ${skillMdPath}'s description contains a literal "<" or ">" character. These can be misread as markup or YAML block-scalar syntax by downstream parsers and renderers -- rewrite the description without them.`,
    );
  }
}

// ahood#1553 step 4 (mandatory, web-side authority): a skill folder reused
// from an INSTALL (which stamps the header inline, add.ts) must never carry
// a stale header into the registry -- its title/version/link would be
// whatever the install last stamped, not this publish's own. stripping
// unconditionally on every root doc, every publish, regardless of whether
// the content actually has a header, is what makes that safe to do without
// knowing where this folder came from: stripProvenanceHeader is a precise,
// position-anchored no-op on content that doesn't match the exact header
// shape there (own module doc comment), so a hand-written root doc that
// never had one is untouched, byte for byte.
async function tarGzDirectory(dir: string, rootDocName?: string): Promise<Buffer> {
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
        const raw = readFileSync(fullPath);
        // `prefix === ""` (top level only): a nested file that happens to
        // share the root doc's name (an example SKILL.md under docs/,
        // say) is never touched.
        const content = prefix === "" && relPath === rootDocName ? Buffer.from(stripProvenanceHeader(raw.toString("utf-8")), "utf-8") : raw;
        tar.entry({ name: relPath, size: content.length }, content);
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

const PUBLISH_VALUE_FLAGS = [
  "--path", "--owner", "--slug", "--version", "--name", "--tagline", "--tags", "--license",
  "--homepage", "--repository", "--kind", "--changelog", "--visibility",
];

function parsePublishArgs(args: string[], USAGE: string): {
  owner: string;
  skill: string;
  version: string;
  path: string;
  name?: string;
  tagline?: string;
  tags?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  kind?: string;
  changelog?: string;
  visibility?: Visibility;
} {
  // Every flag publish reads is declared here and nothing else gets through
  // (ahood-cli#260): `publish a/b@1.0.0 --visiblity public` used to publish
  // with the visibility flag dropped, i.e. private, at exit 0.
  const flags = parseArgs(args, {
    usage: USAGE,
    booleans: ["--json"],
    values: PUBLISH_VALUE_FLAGS,
    max: 1,
  });
  const pathFlag = flags.value("--path");
  let owner = flags.value("--owner");
  let skill = flags.value("--slug");
  let version = flags.value("--version");
  const name = flags.value("--name");
  const tagline = flags.value("--tagline");
  const tags = flags.value("--tags");
  const license = flags.value("--license");
  const homepage = flags.value("--homepage");
  const repository = flags.value("--repository");
  const kind = flags.value("--kind");
  const changelog = flags.value("--changelog");
  const visibility = flags.value("--visibility");
  if (visibility !== undefined && visibility !== "public" && visibility !== "private") {
    throw new UsageError(`--visibility must be "public" or "private" (got "${visibility}").\n${USAGE}`);
  }
  let legacyPath: string | undefined;

  // ahood#990: the `<path> --owner <owner> --slug <skill> --version <x.y.z>`
  // form predates the primary `<owner>/<skill>@<version>` spec form and is
  // deprecated in favor of it -- still works unchanged, one stderr note.
  if (owner !== undefined || skill !== undefined) {
    console.error(
      "Deprecated: the `<path> --owner <owner> --slug <skill> --version <x.y.z>` publish form is deprecated; " +
        "use `ahood skill publish <owner>/<skill>@<version> [--path <dir>]` instead. The legacy form still works.",
    );
  }

  const first = flags.positionals[0];
  if (first) {
    if (first.includes("/") && first.includes("@")) {
      // Primary form: ahood skill publish <owner>/<skill>@<version>
      const parsed = parseOwnerSkill(first.slice(0, first.lastIndexOf("@")), USAGE);
      owner = owner ?? parsed.owner;
      skill = skill ?? parsed.skill;
      version = version ?? first.slice(first.lastIndexOf("@") + 1);
    } else {
      // Legacy form: ahood skill publish <path> --owner ... --slug ... --version ...
      legacyPath = first;
    }
  }

  if (!owner || !skill || !version) throw new UsageError(USAGE);
  if (!SEMVER_RE.test(version)) {
    throw new UsageError(`--version must be a semver like 1.2.3 (got "${version}").\n${USAGE}`);
  }
  if (kind !== undefined && !isCliKind(kind)) {
    throw new UsageError(`--kind must be ${orList(CLI_KINDS.map((k) => `"${k}"`))} (got "${kind}").\n${USAGE}`);
  }
  // Validated here, before any network call (including the tar/gzip of the
  // skill directory) -- these only ever reach the server via
  // createSkillForPublish's create-skill body (ahood-cli#34).
  if (homepage !== undefined) validateExternalUrl(homepage, "--homepage");
  if (repository !== undefined) validateExternalUrl(repository, "--repository");
  return {
    owner,
    skill,
    version,
    path: pathFlag ?? legacyPath ?? ".",
    name,
    tagline,
    tags,
    license,
    homepage,
    repository,
    kind,
    changelog,
    visibility: visibility as Visibility | undefined,
  };
}

type CreateOpts = {
  name?: string;
  tagline?: string;
  tags?: string;
  license?: string;
  homepage?: string;
  repository?: string;
  kind?: string;
  visibility?: Visibility;
};

// ahood#1612: the server creates every new artifact private, and authors
// missed that they then had to run `ahood skill edit --visibility public`
// (zero installs). Asked only at the moment of CREATING (never on a new
// version of an existing artifact), only when --visibility was not given and
// a person can answer: not --json, not piped. Anything else stays private.
async function chooseVisibility(owner: string, skill: string, opts: CreateOpts, jsonOutput: boolean): Promise<Visibility> {
  if (opts.visibility !== undefined) return opts.visibility;
  if (jsonOutput || !isInteractive()) return "private";
  return (await confirmYesNo(`Make ${owner}/${skill} public so others can find and install it? [y/N] `)) ? "public" : "private";
}

// Creates the skill under the caller's own account when versions/init 404s
// -- skill creation is CLI-only now (there is no separate `ahood create`;
// publish creates on first use). --name is required for this path since
// createSkill requires a name; --tagline/--tags/--license/--homepage/
// --repository are optional and only used here, never applied to an
// already-existing skill.
async function createSkillForPublish(
  owner: string,
  skill: string,
  opts: CreateOpts,
  jsonOutput: boolean,
): Promise<CreateResponse> {
  if (!opts.name) {
    throw new Error(
      `${owner}/${skill} doesn't exist yet -- pass --name to create it as part of this publish (e.g. --name "My Skill").`,
    );
  }
  const body: Record<string, unknown> = { slug: skill, name: opts.name };
  if (opts.tagline !== undefined) body.tagline = opts.tagline;
  if (opts.tags !== undefined) body.tags = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (opts.license !== undefined) body.license = opts.license;
  if (opts.homepage !== undefined) body.homepage = opts.homepage;
  if (opts.repository !== undefined) body.repository = opts.repository;
  if (opts.kind !== undefined) body.kind = opts.kind;

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
        `ahood skill publish ${created.owner}/${skill}@<version>.`,
    );
  }
  if (!jsonOutput) {
    console.log(`Created ${created.owner}/${created.slug} -- publishing its first version now.`);
  }
  return created;
}

async function initVersion(
  owner: string,
  skill: string,
  version: string,
  packageSizeBytes: number,
  changelog: string | undefined,
  createOpts: CreateOpts,
  jsonOutput: boolean,
): Promise<{ init: InitResponse; created?: CreateResponse; visibility?: Visibility }> {
  const path = `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/init`;
  // changelog_md matches the field name versions.ts's SkillVersion type already
  // reads on the GET side (ahood-cli#87) -- only sent when --changelog was
  // passed, same "omit rather than null" convention as every other optional
  // flag in this file (see createSkillForPublish's body above).
  const initBody: Record<string, unknown> = { version, package_size_bytes: packageSizeBytes };
  if (changelog !== undefined) initBody.changelog_md = changelog;
  const body = JSON.stringify(initBody);
  try {
    const init = await apiJson<InitResponse>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return { init };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const created = await createSkillForPublish(owner, skill, createOpts, jsonOutput);
    // The create request does not carry visibility (the server creates
    // private; edit's PATCH is the one way to change it), so the choice is
    // applied after the publish succeeds -- a failed upload must not leave a
    // public, empty artifact behind.
    const visibility = await chooseVisibility(owner, skill, createOpts, jsonOutput);
    // Retry exactly once. If this ALSO 404s (e.g. a race, or the create
    // silently didn't take), let that error propagate rather than looping.
    const init = await apiJson<InitResponse>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    return { init, created, visibility };
  }
}

// "a, b, or c" -- for messages that enumerate every kind.
function orList(items: string[]): string {
  return items.length <= 2 ? items.join(" or ") : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

type UpdateResponse = { slug: string; tagline: string | null; tags_warning?: string };

// ahood-cli#(tagline-on-republish): --tagline/--tags/--license/--homepage/
// --repository used to reach the server ONLY via createSkillForPublish's
// create-skill body, which only ever runs on a brand-new artifact (the 404
// branch of initVersion above). On a re-publish of an artifact that already
// exists, initVersion's own request body carries just {version,
// package_size_bytes, changelog_md} (mirrors PATCH /api/v1/skills/{owner}/
// {skill}'s allow-list -- lib/artifacts/mutations/update.ts's
// UpdateSkillInput on the server) -- these metadata flags were parsed off
// argv and then silently dropped on the floor before any request was ever
// made, never sent and never rejected. This applies them the same way
// `ahood skill edit` does: a PATCH with only the fields the caller actually
// passed, so an omitted flag can never clobber an existing value. --name has
// no update path (the PATCH route doesn't accept it -- only create does), so
// it stays create-only; that part of the "used only when creating" docs was
// accurate and remains so.
async function updateExistingSkillMetadata(
  owner: string,
  skill: string,
  opts: { tagline?: string; tags?: string; license?: string; homepage?: string; repository?: string; visibility?: Visibility },
  jsonOutput: boolean,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.tagline !== undefined) body.tagline = opts.tagline;
  if (opts.tags !== undefined) body.tags = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (opts.license !== undefined) body.license = opts.license;
  if (opts.homepage !== undefined) body.homepage = opts.homepage;
  if (opts.repository !== undefined) body.repository = opts.repository;
  // Only an explicit --visibility reaches an existing artifact; a re-publish
  // never prompts and never changes visibility on its own (ahood#1612).
  if (opts.visibility !== undefined) body.visibility = opts.visibility;
  if (Object.keys(body).length === 0) return;

  const updated = await apiJson<UpdateResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!jsonOutput) console.log(`Updated ${owner}/${updated.slug} metadata.`);
  if (updated.tags_warning) console.warn(`WARNING: ${updated.tags_warning}`);
}

// Which kind a publish folder is, from the root docs it holds (KINDS[k].
// rootDoc), so a new kind needs no branch here. An explicit kind must have
// its root doc. With none, exactly one root doc must be present; SKILL.md
// alone returns undefined, the pre-kind behaviour (the server defaults to
// skill). Inference: agent/mcp (ahood-cli#172), doc (#182), project (#185),
// loop (ahood#858), prompt (#206).
function resolvePublishKind(path: string, kind: CliKind | undefined, via: string): CliKind | undefined {
  if (kind !== undefined) {
    const rootDocPath = join(path, KINDS[kind].rootDoc);
    if (!existsSync(rootDocPath)) {
      throw new Error(`No ${KINDS[kind].rootDoc} found at ${rootDocPath} -- ${via} must point at a folder containing ${KINDS[kind].rootDoc}.`);
    }
    return kind;
  }
  const present = CLI_KINDS.filter((k) => existsSync(join(path, KINDS[k].rootDoc)));
  const rootDocs = CLI_KINDS.map((k) => KINDS[k].rootDoc);
  if (present.length > 1) {
    throw new Error(
      `Multiple root files found at ${path} (${present.map((k) => KINDS[k].rootDoc).join(", ")}) -- pass ${orList(CLI_KINDS.map((k) => `--kind ${k}`))} to disambiguate.`,
    );
  }
  if (present.length === 0) {
    throw new Error(`No ${orList(rootDocs)} found at ${path} -- publish must point at a ${orList(CLI_KINDS)} folder's root.`);
  }
  return present[0] === "skill" ? undefined : present[0];
}

// A PROMPT.md that breaks the contract (src/prompt-doc.ts: required
// name/intent, every {{key}} declared and every declared input used, the
// 32 KB body cap) is refused here, before any request, with the server's own
// wording -- which names the offending key -- instead of after a full upload
// (ahood-cli#206). The server enforces the same rules again.
function assertValidPromptMd(path: string): void {
  const result = parsePromptDoc(readFileSync(join(path, KINDS.prompt.rootDoc), "utf8"));
  if (!result.ok) throw new UsageError(`${result.reason}. Fix ${join(path, KINDS.prompt.rootDoc)} and publish again.`);
}

// --json mode (ahood-cli#57): a CI/script caller needs one machine-readable
// object on stdout, not the human progress lines below scraped with a
// regex. jsonOutput therefore gates every intermediate console.log in this
// flow, and the whole body is wrapped in a try/catch so ANY failure --
// validation, network, or a rejected publish -- still yields exactly one
// JSON object (`{error}`) rather than a human message, while still
// rethrowing so index.ts's exit-code mapping (exitCodeFor) is unaffected.
export async function publish(args: string[], scope?: KindScope): Promise<void> {
  const jsonOutput = args.includes("--json");
  try {
    const parsed = parsePublishArgs(args, publishUsage(scope));
    const { owner, skill, version, path, name, tagline, tags, license, homepage, repository, changelog, visibility: visibilityFlag } = parsed;
    // A kind-scoped publish implies its kind. The dispatcher has already
    // refused a contradictory --kind before this runs, so the flag (when the
    // legacy `ahood skill publish` passes one through) and the scope can't
    // disagree here.
    const scopedKind: CliKind | undefined = strictKind(scope);
    const kind = scopedKind ?? parsed.kind;
    const via = scopedKind ? `ahood ${scope!.noun} publish` : `publish --kind ${kind}`;

    const skillMdPath = join(path, KINDS.skill.rootDoc);
    const hasSkillMd = existsSync(skillMdPath);
    const resolvedKind = resolvePublishKind(path, kind as CliKind | undefined, via);

    // ahood-cli#93: fires for an explicit --kind skill, and for the
    // inferred-skill case above (resolvedKind left undefined because
    // SKILL.md was the only root file present) -- but not when SKILL.md
    // merely happens to sit alongside an AGENT.md/server.json being
    // published as --kind agent/mcp instead.
    if (resolvedKind === "skill" || (resolvedKind === undefined && hasSkillMd)) {
      warnAboutSkillDescription(skillMdPath);
    }
    if (resolvedKind === "prompt") assertValidPromptMd(path);

    if (scopedKind !== undefined) await assertPublishTargetKind(scope!, owner, skill);

    const archive = await tarGzDirectory(path, KINDS[resolvedKind ?? "skill"].rootDoc);

    const { init, created, visibility: createdVisibility } = await initVersion(
      owner,
      skill,
      version,
      archive.length,
      changelog,
      { name, tagline, tags, license, homepage, repository, kind: resolvedKind, visibility: visibilityFlag },
      jsonOutput,
    );

    // `created` is only set when this call just created the artifact, in
    // which case createSkillForPublish's create-skill body above already
    // applied these fields. Otherwise this is a re-publish of something that
    // already existed, and the metadata flags still need to reach the server
    // -- see updateExistingSkillMetadata's comment.
    if (!created) {
      await updateExistingSkillMetadata(owner, skill, { tagline, tags, license, homepage, repository, visibility: visibilityFlag }, jsonOutput);
    }

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
      // The signed URL points at Supabase Storage directly, a different host
      // than the API, so this never goes through apiJson -- sanitize by hand
      // here for the same reason apiJson does (ahood-cli#31/#50): a raw
      // proxy/WAF error page must not be spliced verbatim into a thrown Error.
      const rawBody = await putRes.text().catch(() => "");
      const body = rawBody ? sanitizeErrorMessage(rawBody) : "";
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

    if (!jsonOutput) console.log(`Uploaded ${owner}/${skill}@${version} -- processing...`);
    const result = await pollVersionStatus(owner, skill, version);
    if (result.status === "failed") {
      throw new Error(`Publish failed: ${result.failure_reason ?? "unknown reason"}`);
    }

    // ahood#1612: apply the create-time choice now that the first version is
    // in. A private result in a non-interactive run prints the exact command
    // that makes it public; the hint is human-only (--json stays one object).
    let visibilityNote: string | undefined;
    if (created) {
      const ref = `${created.owner}/${created.slug}`;
      if (createdVisibility === "public") {
        await apiJson(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: "public" }),
        });
        visibilityNote = `${ref} is public.`;
      } else if (visibilityFlag === undefined) {
        visibilityNote = `${ref} is private. To let others find and install it: ahood skill edit ${ref} --visibility public`;
      }
    }

    if (jsonOutput) {
      const output: { version: string; status: string; failure_reason?: string; created?: CreateResponse } = {
        version: result.version,
        status: result.status,
      };
      if (result.failure_reason) output.failure_reason = result.failure_reason;
      if (created) output.created = created;
      console.log(JSON.stringify(output));
    } else {
      console.log(`Published ${owner}/${skill}@${result.version} (${result.status})`);
      if (visibilityNote) console.log(visibilityNote);
    }
  } catch (error) {
    if (jsonOutput) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ error: message }));
    }
    throw error;
  }
}
