import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { UsageError } from "../usage-error.js";

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

// publish.ts's only client-side check on SKILL.md is that the file exists
// (see publish.ts's `existsSync(skillMdPath)`) -- actual frontmatter
// validation happens server-side, after upload, as part of the processing
// workflow described in publish.ts's POLL_INTERVAL_MS comment. There's no
// parser to match locally, so this template instead follows the documented
// Claude Code skill format: YAML frontmatter delimited by `---` lines, with
// a `name` and a `description` field -- the same shape every real SKILL.md
// in this ecosystem uses (see e.g. any installed skill under
// .claude/skills/<owner>/<skill>/SKILL.md). Keeping to exactly those two
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
description: TODO -- describe what this skill does and when Claude should use it.
---

## Instructions

TODO: describe, step by step, what Claude should do when this skill is invoked.
`;
}

// Falls back to "my-skill" when the directory name itself isn't usable as a
// bare YAML scalar (empty, or starting with a character like "-" or "@" that
// would need quoting) -- e.g. running `ahood skill init` with no name directly in
// "/" (basename "") or in a directory whose name starts with punctuation.
function skillNameFor(dirPath: string): string {
  const base = basename(dirPath);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base) ? base : "my-skill";
}

export async function init(args: string[]): Promise<void> {
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
  const skillMdPath = join(targetDir, "SKILL.md");

  if (existsSync(skillMdPath)) {
    throw new Error(`SKILL.md already exists at ${skillMdPath} -- refusing to overwrite it.`);
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(skillMdPath, buildSkillMd(name ?? skillNameFor(targetDir)));

  console.log(`Created ${skillMdPath}`);
  console.log("Fill in the description, then flesh out the ## Instructions section.");
  console.log(`Run \`ahood skill publish <owner>/<skill>@<version>${name ? ` --path ${name}` : ""}\` when ready.`);
}
