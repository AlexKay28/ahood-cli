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
//
// Plugin skills only (ahood#1018): the registry copy (alexkay/ahood) and the
// raw `ahood help useme` skill were the other ways to get this guidance, and
// both are retired -- ahood ships as the CLI and the plugin, nothing else.
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

export function renderPluginSkill() {
  return `${frontMatter("using-ahood", PLUGIN_SKILL_DESCRIPTION)}\n\n${GENERATED_NOTE}\n\n${canonicalBody()}`;
}

// A target whose directory is missing (a trimmed checkout) is skipped rather
// than created from nothing.
export function targets() {
  const all = [
    { path: "plugins/ahood/skills/using-ahood/SKILL.md", render: renderPluginSkill },
    { path: "plugins/codex/skills/using-ahood/SKILL.md", render: renderPluginSkill },
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
}

if (import.meta.url === `file://${process.argv[1]}`) main();
