#!/usr/bin/env node
// Writes plugins/ahood/commands/*.md and .claude-plugin/plugin.json (its
// version is the CLI's, ahood#1018) from src/setup/templates/claude-plugin.ts
// (ahood#981), the Codex plugin (plugins/codex/ plus
// .agents/plugins/marketplace.json) from src/setup/templates/codex-plugin.ts
// and the opencode plugin's generated files (packages/opencode-plugin/
// package.json and src/generated.ts) from src/setup/templates/opencode-plugin.ts
// (ahood#1009), the same way sync-readme.mjs regenerates the README's command
// table: build with tsc, then import the compiled module, so the files can
// never drift from what the tests check.
//
// Usage:
//   node scripts/sync-plugin.mjs          # rewrite the command files in place
//   node scripts/sync-plugin.mjs --check  # exit 1 if any is stale (no write)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = path.join(rootDir, "node_modules", ".bin", "tsc");

execFileSync(existsSync(tscBin) ? tscBin : "npx", existsSync(tscBin) ? ["-p", "tsconfig.json"] : ["tsc", "-p", "tsconfig.json"], {
  cwd: rootDir,
  stdio: "inherit",
});

const { CLAUDE_PLUGIN_DIR, claudePluginFiles } = await import(
  path.join(rootDir, "dist", "setup", "templates", "claude-plugin.js")
);
const { codexPluginFiles } = await import(path.join(rootDir, "dist", "setup", "templates", "codex-plugin.js"));
const { opencodePluginFiles } = await import(path.join(rootDir, "dist", "setup", "templates", "opencode-plugin.js"));

// Both lists as paths relative to the repo root.
const files = [
  ...claudePluginFiles().map(({ file, content }) => ({ file: path.join(CLAUDE_PLUGIN_DIR, file), content })),
  ...codexPluginFiles(),
  ...opencodePluginFiles(),
];

const checkMode = process.argv.includes("--check");
const stale = [];
for (const { file, content } of files) {
  const target = path.join(rootDir, file);
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === content) continue;
  stale.push(path.relative(rootDir, target));
  if (!checkMode) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

if (checkMode && stale.length > 0) {
  console.error(`Out of date with src/setup/templates/claude-plugin.ts / codex-plugin.ts / opencode-plugin.ts: ${stale.join(", ")}\nRun \`npm run sync-plugin\`.`);
  process.exit(1);
}
console.log(stale.length === 0 ? "Plugin files already up to date." : `Updated: ${stale.join(", ")}`);
