#!/usr/bin/env node
// Fails unless every plugin manifest is at the root package.json's version
// (ahood#1009, ahood#1018): one version for the CLI and all three plugins.
//   - packages/opencode-plugin/package.json: one tag publishes both npm
//     packages, and `ahood setup opencode` / `ahood doctor` look for the
//     plugin at the CLI's own version.
//   - plugins/codex/.codex-plugin/plugin.json: Codex caches the plugin per
//     version.
//   - plugins/ahood/.claude-plugin/plugin.json: Claude Code updates an
//     installed plugin only when this version changes; and the Claude
//     marketplace entry (.claude-plugin/marketplace.json) must not set a
//     version of its own (plugin.json wins silently, so a second one only
//     drifts).
// The plugins' /ahood commands also run `npx -y @ahood/cli@<this version>`,
// so a plugin at any other version runs a different CLI than it shipped with.
// `npm version` keeps them in sync (the `version` hook runs sync-plugin, then
// this); the release workflow runs it again to catch a hand edit.
//
// Usage:
//   node scripts/check-plugin-version.mjs [repo-root]   # default: this repo

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every manifest whose `version` must equal the root package.json's. */
export const PLUGIN_MANIFESTS = [
  path.join("packages", "opencode-plugin", "package.json"),
  path.join("plugins", "codex", ".codex-plugin", "plugin.json"),
  path.join("plugins", "ahood", ".claude-plugin", "plugin.json"),
];
export const CLAUDE_MARKETPLACE = path.join(".claude-plugin", "marketplace.json");

const readJson = (rootDir, file) => JSON.parse(readFileSync(path.join(rootDir, file), "utf8"));

/** Returns null when every version matches, otherwise the error message (one line per problem). */
export function pluginVersionMismatch(rootDir) {
  const root = readJson(rootDir, "package.json");
  const problems = [];
  for (const file of PLUGIN_MANIFESTS) {
    const plugin = readJson(rootDir, file);
    if (plugin.version !== root.version) {
      problems.push(`${plugin.name}@${plugin.version} (${file}) does not match ${root.name}@${root.version} (package.json).`);
    }
  }
  for (const entry of readJson(rootDir, CLAUDE_MARKETPLACE).plugins ?? []) {
    if (entry.version !== undefined) {
      problems.push(`${CLAUDE_MARKETPLACE} sets version ${entry.version} on ${entry.name}; remove it (plugin.json carries the version).`);
    }
  }
  if (problems.length === 0) return null;
  return [...problems, "Run `npm run sync-plugin` and commit the result."].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const mismatch = pluginVersionMismatch(rootDir);
  if (mismatch) {
    console.error(mismatch);
    process.exit(1);
  }
  console.log("Every plugin (opencode, Codex, Claude Code) is at the CLI's version.");
}
