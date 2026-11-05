#!/usr/bin/env node
// Generates commands.json (repo root, shipped in the npm package) from
// src/help.ts's *_COMMANDS_HELP arrays, so the ahood website's /docs command
// list can be generated from it instead of being a hand-synced fourth copy
// (AlexKay28/ahood#995). Same build-then-import approach as sync-readme.mjs:
// no ts-node/tsx dependency, and it reads the very module `ahood --help` does.
//
// The file deliberately carries no package version: a release bump must not
// make it stale, only a real change to the command reference may.
//
// Usage:
//   node scripts/emit-commands-json.mjs          # rewrite commands.json
//   node scripts/emit-commands-json.mjs --check  # exit 1 if commands.json is stale (no write)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const COMMANDS_JSON_PATH = path.join(rootDir, "commands.json");

// Group id -> exported array name, in the same order as README's tables
// (sync-readme.mjs renderTables). The id is the noun after `ahood`, or
// "top-level" for the flat account/install commands.
export const GROUPS = [
  ["top-level", "TOP_LEVEL_COMMANDS_HELP"],
  ["skill", "SKILL_COMMANDS_HELP"],
  ["agent", "AGENT_COMMANDS_HELP"],
  ["mcp", "MCP_COMMANDS_HELP"],
  ["doc", "DOC_COMMANDS_HELP"],
  ["project", "PROJECT_COMMANDS_HELP"],
  ["loop", "LOOP_COMMANDS_HELP"],
  ["prompt", "PROMPT_COMMANDS_HELP"],
  ["group", "GROUP_COMMANDS_HELP"],
  ["snap", "SNAP_COMMANDS_HELP"],
];

// Aliases come from help.ts's own usageWithAliases (the token it rewrites to
// "view|show"), so this never needs its own copy of the alias rules.
function aliasesOf(entry, usageWithAliases) {
  const plain = entry.usage.split(" ");
  const aliased = usageWithAliases(entry).split(" ");
  const idx = aliased.findIndex((token, i) => token !== plain[i]);
  return idx === -1 ? [] : aliased[idx].split("|").slice(1);
}

function toEntry(entry, usageWithAliases) {
  const out = { usage: entry.usage, summary: entry.summary, desc: entry.desc };
  if (entry.flags) out.flags = entry.flags;
  if (entry.examples) out.examples = entry.examples;
  const aliases = aliasesOf(entry, usageWithAliases);
  if (aliases.length > 0) out.aliases = aliases;
  return out;
}

// `help` is the help module (dist/help.js, or src/help.ts under vitest).
// Returns the exact file contents, trailing newline included.
export function renderCommandsJson(help) {
  const groups = GROUPS.map(([id, exportName]) => {
    const list = help[exportName];
    if (!Array.isArray(list)) throw new Error(`help module has no ${exportName} array`);
    return { id, commands: list.map((entry) => toEntry(entry, help.usageWithAliases)) };
  });
  const doc = {
    $comment: "Generated from src/help.ts by scripts/emit-commands-json.mjs -- do not edit by hand.",
    groups,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function main() {
  const tscBin = path.join(rootDir, "node_modules", ".bin", "tsc");
  // Rebuild first so dist/help.js always reflects the current src/help.ts.
  execFileSync(existsSync(tscBin) ? tscBin : "npx", existsSync(tscBin) ? ["-p", "tsconfig.json"] : ["tsc", "-p", "tsconfig.json"], {
    cwd: rootDir,
    stdio: "inherit",
  });
  const help = await import(path.join(rootDir, "dist", "help.js"));
  const expected = renderCommandsJson(help);
  const current = existsSync(COMMANDS_JSON_PATH) ? readFileSync(COMMANDS_JSON_PATH, "utf8") : null;

  if (process.argv.includes("--check")) {
    if (current !== expected) {
      console.error(
        "commands.json is out of date with src/help.ts's COMMANDS_HELP.\n" +
          "Run `npm run emit-commands` to regenerate it.",
      );
      process.exit(1);
    }
    console.log("commands.json is up to date.");
  } else if (current !== expected) {
    writeFileSync(COMMANDS_JSON_PATH, expected);
    console.log("commands.json updated from src/help.ts's COMMANDS_HELP.");
  } else {
    console.log("commands.json already up to date.");
  }
}

// Only run when invoked as a script, so tests can import renderCommandsJson
// without triggering a tsc build or a write.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
