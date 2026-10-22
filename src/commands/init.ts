import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { UsageError } from "../usage-error.js";
import { CLI_KINDS, KINDS, strictKind, type CliKind, type KindScope } from "../kinds.js";
import { flagValue } from "../flags.js";
import { detectProjectRemote, normalizeProjectRemote } from "../project-remote.js";

const USAGE = "Usage: ahood skill init [name]";

// Mirrors the server's slug convention referenced by ahood-cli#60 (and the
// same shape as spec.ts's SEGMENT_RE, minus "." and "_" -- skill slugs are
// strictly lowercase-alnum-and-hyphen). A name that already matches this is
// left untouched; one that doesn't gets normalized rather than rejected,
// since `init` is meant to be the friendly first-run command.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Lowercases and collapses any run of non-alphanumeric characters (spaces,
// punctuation, path separators that survived the containment check, etc.)
// into a single hyphen, then trims leading/trailing hyphens. E.g.
// "Bad Name!" -> "bad-name".
function normalizeToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// publish.ts's only hard client-side check on SKILL.md is that the file
// exists (see publish.ts's `existsSync(skillMdPath)`) -- actual frontmatter
// validation happens server-side, after upload, as part of the processing
// workflow described in publish.ts's POLL_INTERVAL_MS comment. (Publish does
// also do a best-effort, non-blocking scan of `description` at publish time
// -- ahood-cli#93 -- but that's a warning, not a parser, and this scaffold's
// job is to steer authors clear of it in the first place.) There's no real
// YAML parser to match locally, so this template instead follows the
// documented Claude Code skill format: YAML frontmatter delimited by `---`
// lines, with a `name` and a `description` field -- the same shape every
// real SKILL.md in this ecosystem uses (see e.g. any installed skill under
// .claude/skills/<owner>@<skill>/SKILL.md). Keeping to exactly those two
// fields, rather than inventing extra ones, means nothing here needs
// updating just because publish.ts's own validation happens to be looser
// today.
function buildSkillMd(name: string): string {
  return `---
# name: a short, unique identifier for this skill (kebab-case is
# conventional, e.g. "pdf-tools"). Not the same as the <skill> slug you
# publish under -- ahood skill publish reads that from the command line -- but
# keeping them in sync avoids confusion.
name: ${name}
# description: one or two sentences describing what this skill does and
# when Claude should use it. This is the primary text Claude reads to
# decide whether to invoke the skill, so be specific rather than generic.
# Keep it on a single line, under 1024 characters, and free of "<"/">"
# characters -- ahood skill publish warns about all three, because in
# registry-first usage (no local file, loaded via the registry/MCP server)
# this description is the *only* signal deciding whether the skill is ever
# triggered at all.
description: TODO -- describe what this skill does and when Claude should use it.
---

## Instructions

TODO: describe, step by step, what Claude should do when this skill is invoked.
`;
}

// AGENT.md, for `ahood agent init` (ahood-cli#172). The backend's publish
// validator (lib/publish/parse-agent-frontmatter.ts in the ahood repo) is a
// hand-rolled flat `key: value` reader, not YAML: it requires the file to
// START with a `---` line, a closing `---` line followed by a newline, and
// non-empty `name` and `description`; an optional `skills: [owner/slug, ...]`
// flow list must hold owner/slug entries. Claude Code's own subagent loader
// reads the same frontmatter (name, description, and optionally tools and
// model). So: no leading comment above the opening `---` (that alone fails
// publish), and the optional keys are left as commented-out examples, with
// no colon in any prose comment, so neither reader can mistake a comment for
// a key.
function buildAgentMd(name: string): string {
  return `---
name: ${name}
description: TODO -- describe what this agent does and when Claude should delegate to it.
# Optional. Uncomment to restrict the tools this agent may use (omit to inherit all).
# tools: Read, Grep, Glob
# Optional. Uncomment to pin a model for this agent.
# model: sonnet
---

TODO -- write the system prompt for this agent. Say what it is responsible for,
the steps it should take, and what it should hand back when it is done.
`;
}

// server.json, for `ahood mcp init` (ahood-cli#172). Mirrors exactly what the
// backend's publish validator (lib/publish/parse-server-manifest.ts in the
// ahood repo) accepts: a JSON object with non-empty `name` and `description`
// and exactly one of `packages` (one npm/npx entry) or `remotes` (one http(s)
// url). The starter uses `remotes`, pointed at a reserved example.com host
// (RFC 2606), deliberately: a `packages` placeholder would name an npm
// package that `ahood mcp add` turns into `npx -y <identifier>@<version>` --
// an install of whatever someone later publishes under that name if the
// starter were ever published unedited. A reserved host can never resolve to
// anyone's server. JSON has no comments, so the editing guidance is printed
// by init instead.
function buildServerJson(name: string): string {
  const manifest = {
    name,
    description: "TODO -- describe what this MCP server does and when an agent should use it.",
    remotes: [{ url: "https://mcp.example.com/mcp" }],
  };
  return `${JSON.stringify(manifest, null, 2)}
`;
}

// DOC.md, for `ahood doc init` (ahood-cli#182). The backend's publish
// validator (lib/publish/parse-doc-frontmatter.ts in the ahood repo) is the
// same hand-rolled flat `key: value` reader as AGENT.md's, minus the skills
// list: the file must START with a `---` line, the closing `---` line must be
// followed by a newline, and `name` and `description` must be non-empty. So
// the same rules as buildAgentMd apply: nothing above the opening `---`, and
// no colon in a comment line inside the frontmatter.
function buildDocMd(name: string): string {
  return `---
name: ${name}
description: TODO -- one line saying what this doc covers and when an agent should read it.
---

# ${name}

TODO -- write the documentation here. Plain Markdown; this whole file, frontmatter
included, is what \`ahood doc read\` prints and \`ahood doc add\` saves.
`;
}

// PROJECT.md, for `ahood project init` (ahood-cli#185). The backend's
// validator (lib/publish/parse-project-frontmatter.ts) is DOC.md's flat
// reader plus one optional field, `project`: a git remote, normalized there
// to host/owner/repo. It is written already normalized, or left out.
function buildProjectMd(name: string, project?: string): string {
  return `---
name: ${name}
description: TODO -- one line saying which repository this guide is for and when an agent should read it.
${project ? `project: ${project}\n` : ""}---

# ${name}

TODO -- how to work in this repository: conventions, how to verify a change, and the
traps. Plain Markdown; \`ahood project add\` saves this whole file to .claude/project.md.
`;
}

// LOOP.md, for `ahood loop init` (ahood-cli, ahood#858). The backend's
// validator (lib/publish/parse-loop-frontmatter.ts) is DOC.md's exact flat
// reader -- no extra field, unlike PROJECT.md's optional `project` remote,
// since a loop is explicitly portable across repositories rather than
// scoped to one. Same rules as buildDocMd apply: nothing above the opening
// `---`, and no colon in a comment line inside the frontmatter.
function buildLoopMd(name: string): string {
  return `---
name: ${name}
description: TODO -- one line saying what kind of recurring agentic session this loop is for.
---

# ${name}

TODO -- the pseudocode and rules for running this kind of session: the steps, the order,
and what to do at each decision point. Plain Markdown; \`ahood loop add\` saves this whole
file to .claude/loops/<owner>@<loop>.md.
`;
}

const TEMPLATES: Record<CliKind, (name: string, project?: string) => string> = {
  skill: buildSkillMd,
  agent: buildAgentMd,
  mcp: buildServerJson,
  doc: buildDocMd,
  project: buildProjectMd,
  loop: buildLoopMd,
};

const NEXT_STEPS: Record<CliKind, string[]> = {
  skill: ["Fill in the description, then flesh out the ## Instructions section."],
  agent: ["Fill in the description, then write the agent's system prompt below the frontmatter."],
  mcp: [
    "Fill in the description and point remotes[0].url at your server's https endpoint, or replace",
    '"remotes" with one npm package: "packages": [{"registry_type": "npm", "runtime_hint": "npx",',
    '"identifier": "<npm-package>", "version": "<x.y.z>"}] (plus optional "environment_variables").',
  ],
  doc: ["Fill in the description, then write the doc below the frontmatter."],
  project: ["Fill in the description, then write the guide below the frontmatter."],
  loop: ["Fill in the description, then write the loop's pseudocode and rules below the frontmatter."],
};

// `project init`'s flags for the `project` field (ahood-cli#185), parsed and
// validated up front: --project <remote> sets it, --no-project leaves it out.
// A rejected remote is not echoed, since it can carry a token.
type ProjectFlags = { rest: string[]; explicit?: string; skip: boolean };

function parseProjectFlags(args: string[]): ProjectFlags {
  const raw = flagValue(args, "--project");
  const skip = args.includes("--no-project");
  if (skip && raw !== undefined) throw new UsageError("Pass --project <remote> or --no-project, not both.");
  const rest = args.filter(
    (a, i) => a !== "--no-project" && a !== "--project" && !a.startsWith("--project=") && args[i - 1] !== "--project",
  );
  if (raw === undefined) return { rest, skip };
  const normalized = normalizeProjectRemote(raw);
  if (!normalized.ok) throw new UsageError(`--project is ${normalized.reason}.`);
  return { rest, explicit: normalized.value, skip };
}

// The field's value: the flags' choice, else this repository's origin. Only
// the normalized remote is ever printed or written.
function resolveProjectField(flags: ProjectFlags): string | undefined {
  if (flags.skip) return undefined;
  if (flags.explicit !== undefined) return flags.explicit;
  const detected = detectProjectRemote();
  if (detected) console.log(`Filled project: ${detected} (from \`git remote get-url origin\`; pass --no-project to leave it out).`);
  return detected;
}

// Falls back to "my-skill" when the directory name itself isn't usable as a
// bare YAML scalar (empty, or starting with a character like "-" or "@" that
// would need quoting) -- e.g. running `ahood skill init` with no name directly in
// "/" (basename "") or in a directory whose name starts with punctuation.
function skillNameFor(dirPath: string, fallback = "my-skill"): string {
  const base = basename(dirPath);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base) ? base : fallback;
}

export async function init(args: string[], scope?: KindScope): Promise<void> {
  const strict = strictKind(scope);
  const kind: CliKind = strict ?? "skill";
  const projectFlags = kind === "project" ? parseProjectFlags(args) : undefined;
  if (projectFlags) args = projectFlags.rest;
  let name = args[0];
  if (name !== undefined && name.startsWith("-")) throw new UsageError(USAGE);

  if (name) {
    // Path containment first (ahood-cli#61), mirroring spec.ts's
    // validateSegment containment discipline used by add/remove: a resolved
    // path that escapes the current directory is a hard rejection, since
    // normalizing something meant to escape the directory doesn't make
    // sense -- this has to run on the raw name, before any slug
    // normalization would mangle "/" and ".." into harmless hyphens.
    const cwd = resolve(process.cwd());
    const resolvedName = resolve(cwd, name);
    if (resolvedName !== cwd && !resolvedName.startsWith(cwd + sep)) {
      throw new UsageError(
        `Invalid name "${name}" -- resolves to "${resolvedName}", which is outside the current directory (${cwd}). Refusing to create files outside the project directory.`,
      );
    }

    // Then slug normalization (ahood-cli#60): a name that stays within cwd
    // but isn't already a valid slug gets normalized with a note, rather
    // than rejected outright.
    if (!SLUG_RE.test(name)) {
      const normalized = normalizeToSlug(name);
      if (!normalized) {
        throw new UsageError(
          `Invalid name "${name}" -- could not derive a valid name from it (must contain at least one letter or digit).`,
        );
      }
      console.log(`Note: normalized "${name}" to "${normalized}".`);
      name = normalized;
    }
  }

  const targetDir = name ? resolve(name) : process.cwd();
  const rootDoc = KINDS[kind].rootDoc;
  const docPath = join(targetDir, rootDoc);

  if (existsSync(docPath)) {
    throw new Error(`${rootDoc} already exists at ${docPath} -- refusing to overwrite it.`);
  }
  // A kind-scoped init also refuses a folder that already holds ANOTHER
  // kind's root document: one folder is one artifact, and a second root doc
  // makes a plain `ahood skill publish` of that folder ambiguous. The legacy
  // `ahood skill init` keeps its exact pre-#172 behavior.
  if (strict !== undefined) {
    for (const other of CLI_KINDS) {
      if (other === kind) continue;
      const otherPath = join(targetDir, KINDS[other].rootDoc);
      if (existsSync(otherPath)) {
        throw new Error(
          `${otherPath} already exists -- that folder is already ${KINDS[other].article} ${KINDS[other].label}. ` +
            `Refusing to add ${rootDoc} next to it; pick another name.`,
        );
      }
    }
  }

  const project = projectFlags ? resolveProjectField(projectFlags) : undefined;
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(docPath, TEMPLATES[kind](name ?? skillNameFor(targetDir, `my-${kind}`), project));

  console.log(`Created ${docPath}`);
  for (const line of NEXT_STEPS[kind]) console.log(line);
  const placeholder = KINDS[kind].placeholder;
  console.log(`Run \`ahood ${strict ?? "skill"} publish <owner>/${placeholder}@<version>${name ? ` --path ${name}` : ""}\` when ready.`);
}
