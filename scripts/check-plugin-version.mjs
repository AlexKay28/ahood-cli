#!/usr/bin/env node
// Fails unless packages/opencode-plugin/package.json is at the root
// package.json's version (ahood#1009). One tag publishes both packages, and
// `ahood setup opencode` / `ahood doctor` look for the plugin at the CLI's own
// version, so a plugin at any other version is a release that installs nothing.
// `npm version` keeps them in sync (the `version` hook runs sync-plugin, then
// this); the release workflow runs it again to catch a hand edit.
//
// Usage:
//   node scripts/check-plugin-version.mjs [repo-root]   # default: this repo

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_MANIFEST = path.join("packages", "opencode-plugin", "package.json");

/** Returns null when the versions match, otherwise the error message. */
export function pluginVersionMismatch(rootDir) {
  const root = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(path.join(rootDir, PLUGIN_MANIFEST), "utf8"));
  if (plugin.version === root.version) return null;
  return (
    `${plugin.name}@${plugin.version} (${PLUGIN_MANIFEST}) does not match ${root.name}@${root.version} (package.json). ` +
    "Run `npm run sync-plugin` and commit the result."
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const mismatch = pluginVersionMismatch(rootDir);
  if (mismatch) {
    console.error(mismatch);
    process.exit(1);
  }
  console.log("@ahood/opencode-plugin is at the CLI's version.");
}
