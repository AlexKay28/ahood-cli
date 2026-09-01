#!/usr/bin/env node
// Generates README.md's "Commands" table from src/help.ts's COMMANDS_HELP
// array, so the two don't have to be hand-synced (see issue #69 -- this has
// drifted 3+ times, see issue #65).
//
// This is an ESM/tsc project with no ts-node/tsx in devDependencies, so the
// simplest robust way to read COMMANDS_HELP is to build the project (tsc
// already knows how) and import the compiled dist/help.js -- no new deps,
// and it can never drift from what `ahood --help` actually prints, since
// that reads the very same compiled module.
//
// Usage:
//   node scripts/sync-readme.mjs          # rewrite README.md's table in place
//   node scripts/sync-readme.mjs --check  # exit 1 if README.md's table is stale (no write)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = path.join(rootDir, "README.md");
const tscBin = path.join(rootDir, "node_modules", ".bin", "tsc");

const START_MARKER = "<!-- COMMANDS_TABLE_START -->";
const END_MARKER = "<!-- COMMANDS_TABLE_END -->";

// Rebuild first so dist/help.js always reflects the current src/help.ts.
execFileSync(existsSync(tscBin) ? tscBin : "npx", existsSync(tscBin) ? ["-p", "tsconfig.json"] : ["tsc", "-p", "tsconfig.json"], {
  cwd: rootDir,
  stdio: "inherit",
});

const { TOP_LEVEL_COMMANDS_HELP, SKILL_COMMANDS_HELP, usageWithAliases } = await import(
  path.join(rootDir, "dist", "help.js")
);

// Markdown table cells split on every unescaped `|`, even inside a code
// span, so any `|` in a usage string (e.g. "view|show" aliases, or
// "<bash|zsh|fish>") has to be backslash-escaped to stay inside its cell.
function escapeForTableCell(text) {
  return text.replace(/\|/g, "\\|");
}

function renderTable(entries) {
  const rows = entries.map(
    (entry) => `| \`${escapeForTableCell(usageWithAliases(entry))}\` | ${escapeForTableCell(entry.summary)} |`,
  );
  return ["| Command | What it does |", "| --- | --- |", ...rows].join("\n");
}

// Two tables, gh-style: account-scoped commands (login/logout/whoami/token/
// completion) stay flat; everything else is reached as `ahood skill <verb>`.
function renderTables() {
  return [
    "### Account",
    "",
    renderTable(TOP_LEVEL_COMMANDS_HELP),
    "",
    "### Skill",
    "",
    renderTable(SKILL_COMMANDS_HELP),
  ].join("\n");
}

function withTableReplaced(readme, table) {
  const startIdx = readme.indexOf(START_MARKER);
  const endIdx = readme.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`README.md is missing the ${START_MARKER} / ${END_MARKER} markers around the commands table.`);
  }
  const before = readme.slice(0, startIdx + START_MARKER.length);
  const after = readme.slice(endIdx);
  return `${before}\n${table}\n${after}`;
}

const readme = readFileSync(readmePath, "utf8");
const updated = withTableReplaced(readme, renderTables());
const checkMode = process.argv.includes("--check");

if (checkMode) {
  if (updated !== readme) {
    console.error(
      "README.md's command table is out of date with src/help.ts's COMMANDS_HELP.\n" +
        "Run `npm run sync-readme` to regenerate it.",
    );
    process.exit(1);
  }
  console.log("README.md's command table is up to date.");
} else {
  if (updated !== readme) {
    writeFileSync(readmePath, updated);
    console.log("README.md's command table updated from src/help.ts's COMMANDS_HELP.");
  } else {
    console.log("README.md's command table already up to date.");
  }
}
