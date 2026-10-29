#!/usr/bin/env node
// ahood#990 decision C: one self-skill source. src/skill/using-ahood.md is
// the canonical body of "the ahood self-skill" -- how an agent uses ahood's
// MCP tools and CLI inside a session, captures snaps, and keeps installs
// current. Every place that teaches an agent the same thing is generated
// from it, with its own frontmatter for its own install context:
//
//   - plugins/ahood/skills/using-ahood/SKILL.md -- the skill `ahood setup`
//     bundles with the Claude Code plugin (name: using-ahood; not a
//     registry entry, ships straight from this git repo).
//   - plugins/codex/skills/using-ahood/SKILL.md -- the same skill in the
//     Codex plugin (ahood#1009), next to its `ahood` command skill.
//   - .claude/skills/alexkay@ahood/SKILL.md -- this repo's own dev-installed
//     copy of the registry-published "alexkay/ahood" skill (name: ahood).
//     Publishing a new version from it is a separate, owner-run step (see
//     the command printed by `--check`'s failure message / this script's
//     own trailing log) -- this script only keeps the on-disk copy in sync
//     with the canonical body so there's something correct to publish.
//
// `ahood help useme` (src/useme/SKILL.md) is a third, deliberately separate
// document -- a full CLI reference, not an agent-facing "how to use ahood in
// a session" crib -- so it is not generated from this file.
//
// Usage:
//   node scripts/sync-skill.mjs          # rewrite the generated files in place
//   node scripts/sync-skill.mjs --check  # exit 1 if any is stale (no write)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CANONICAL_PATH = "src/skill/using-ahood.md";

export function canonicalBody() {
  return readFileSync(path.join(rootDir, CANONICAL_PATH), "utf8").trimEnd() + "\n";
}

const GENERATED_NOTE =
  "<!-- Generated from src/skill/using-ahood.md by `npm run sync-skill`; edit that file, not this one. -->";

function frontMatter(name, description) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

export const PLUGIN_SKILL_DESCRIPTION =
  "Use ahood (ahood.dev), the registry of AI agent skills, agents, MCP servers and docs, from inside a session -- " +
  "search and install artifacts through the ahood MCP tools, capture private snaps of what a session learned, and " +
  'keep installed skills current. Use when the user mentions ahood, asks to find or install a skill, agent or MCP ' +
  'server, says "snap this" or "remember this lesson", after you hand over a deliverable, or right after the user ' +
  "corrects you.";

export const REGISTRY_SKILL_DESCRIPTION =
  "How to use the ahood CLI (@ahood/cli) and MCP tools, the registry for reusable AI-agent skills, subagent " +
  "definitions, MCP server manifests and docs. Load BEFORE running any ahood command; before writing a " +
  "non-trivial reusable skill, subagent or MCP integration from scratch (search the registry first); when " +
  "installing, updating, removing, publishing or sharing one; when capturing a private snap; or when setting up " +
  "headless/CI access with AHOOD_TOKEN. Triggers -- ahood, skill registry, is there a skill for this, install a " +
  "skill, publish a skill, snap this, remember this lesson, AHOOD_TOKEN.";

export function renderPluginSkill() {
  return `${frontMatter("using-ahood", PLUGIN_SKILL_DESCRIPTION)}\n\n${GENERATED_NOTE}\n\n${canonicalBody()}`;
}

export function renderRegistrySkill() {
  return `${frontMatter("ahood", REGISTRY_SKILL_DESCRIPTION)}\n\n${GENERATED_NOTE}\n\n${canonicalBody()}`;
}

// `.claude/skills/alexkay@ahood` only exists at all because this repo
// dogfoods its own registry skill (`ahood skill add alexkay/ahood`) -- a
// fresh clone or a clone of a fork without that install has nothing to
// regenerate, so that target is skipped rather than created from nothing
// (creating it here would also desync the real `.claude/skills.lock.json`
// pin/checksum, which only `ahood skill add`/`update` may touch).
export function targets() {
  const all = [
    { path: "plugins/ahood/skills/using-ahood/SKILL.md", render: renderPluginSkill },
    { path: "plugins/codex/skills/using-ahood/SKILL.md", render: renderPluginSkill },
    { path: ".claude/skills/alexkay@ahood/SKILL.md", render: renderRegistrySkill },
  ];
  return all.filter((t) => existsSync(path.join(rootDir, path.dirname(t.path))));
}

function main() {
  const checkMode = process.argv.includes("--check");
  const stale = [];
  for (const { path: relPath, render } of targets()) {
    const target = path.join(rootDir, relPath);
    const content = render();
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === content) continue;
    stale.push(relPath);
    if (!checkMode) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  if (checkMode && stale.length > 0) {
    console.error(`Out of date with ${CANONICAL_PATH}: ${stale.join(", ")}\nRun \`npm run sync-skill\`.`);
    process.exit(1);
  }
  console.log(stale.length === 0 ? "Self-skill files already up to date." : `Updated: ${stale.join(", ")}`);
  console.log(
    "Owner step (not run by this script): publish the registry copy with " +
      "`ahood skill publish alexkay/ahood@<new-version> --path .claude/skills/alexkay@ahood --changelog \"...\"`.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
