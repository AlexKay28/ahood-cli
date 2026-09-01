import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const USAGE = "Usage: ahood init [name]";

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
# publish under -- ahood publish reads that from the command line -- but
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
// would need quoting) -- e.g. running `ahood init` with no name directly in
// "/" (basename "") or in a directory whose name starts with punctuation.
function skillNameFor(dirPath: string): string {
  const base = basename(dirPath);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base) ? base : "my-skill";
}

export async function init(args: string[]): Promise<void> {
  const name = args[0];
  if (name !== undefined && name.startsWith("-")) throw new Error(USAGE);

  const targetDir = name ? resolve(name) : process.cwd();
  const skillMdPath = join(targetDir, "SKILL.md");

  if (existsSync(skillMdPath)) {
    throw new Error(`SKILL.md already exists at ${skillMdPath} -- refusing to overwrite it.`);
  }

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(skillMdPath, buildSkillMd(name ?? skillNameFor(targetDir)));

  console.log(`Created ${skillMdPath}`);
  console.log("Fill in the description, then flesh out the ## Instructions section.");
  console.log(`Run \`ahood publish <owner>/<skill>@<version>${name ? ` --path ${name}` : ""}\` when ready.`);
}
