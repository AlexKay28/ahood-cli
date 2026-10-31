#!/usr/bin/env node
// Fails unless plugins/ahood/CHANGELOG.md has a `## <version>` section for the
// version being released (ahood#1018 step E), so Claude Code's "Plugin
// updated" notice always has something to show. One rule, two places:
//   - `npm version`'s `preversion` hook, with $npm_new_version: it runs
//     before npm touches a file, so a bump without an entry stops cleanly
//     (write and commit the entry, then run `npm version` again);
//   - the release workflow, with package.json's version, before publishing.
//
// Usage:
//   node scripts/check-changelog.mjs [version] [repo-root]   # default: package.json's version, this repo

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CHANGELOG = path.join("plugins", "ahood", "CHANGELOG.md");

/** True when `text` has a `## <version>` heading (anything after a space may follow, e.g. a date). */
export function hasSection(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escaped}(?:\\s|$)`, "m").test(text);
}

/** Returns null when the section is there, otherwise the error message. */
export function changelogProblem(rootDir, version) {
  let text;
  try {
    text = readFileSync(path.join(rootDir, CHANGELOG), "utf8");
  } catch {
    return `${CHANGELOG} is missing; it needs a "## ${version}" section.`;
  }
  if (hasSection(text, version)) return null;
  return (
    `${CHANGELOG} has no "## ${version}" section. Add one (what changed for plugin users), commit it, ` +
    "then run `npm version` again."
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const version = process.argv[2] || JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
  const problem = changelogProblem(rootDir, version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`${CHANGELOG} has a section for ${version}.`);
}
