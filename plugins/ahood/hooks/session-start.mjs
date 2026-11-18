#!/usr/bin/env node
// Generated from src/setup/templates/claude-plugin.ts's claudePluginSessionStartHook() by `npm run sync-plugin`; edit that function, not this file.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CACHE_FILE_ENV = "AHOOD_SESSION_START_CACHE_FILE";
export const INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BUDGET_MS = 3000;
const ARGV = ["npx","-y","@ahood/cli@0.19.0","status","--json"];
const SEVERITY_RANK = { required: 2, action: 1, info: 0 };

function cachePath(env) {
  return env[CACHE_FILE_ENV] || join(env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "ahood-session-start"), "status-cache.json");
}

export function readCache(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.checked_at === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function isStale(cache, now = Date.now()) {
  if (!cache) return true;
  const checkedAt = Date.parse(cache.checked_at);
  return Number.isNaN(checkedAt) || now - checkedAt >= INTERVAL_MS;
}

function writeCache(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ checked_at: new Date().toISOString() }));
  } catch {
    // Best-effort: no cache written just means the next session tries again.
  }
}

/** Runs the pinned CLI's `status --json`, at most BUDGET_MS; null on any failure (no token, no network, a non-zero exit, a malformed response). */
export function runStatus(env) {
  try {
    const out = execFileSync(ARGV[0], ARGV.slice(1), { timeout: BUDGET_MS, encoding: "utf-8", env, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** The additionalContext text, or null when there is nothing worth telling the agent. */
export function buildContext(status) {
  if (!status) return null;
  const updates = Array.isArray(status.items) ? status.items.filter((i) => i && i.update_available) : [];
  const notices = Array.isArray(status.notices) ? status.notices : [];
  if (updates.length === 0 && notices.length === 0) return null;
  const lines = ["ahood: there is something to tell the user (relay it in one line; never run either suggestion yourself)."];
  if (updates.length > 0) lines.push(`${updates.length} installed skill/agent/MCP server update(s) are available.`);
  if (notices.length > 0) {
    const top = notices.reduce((best, n) => ((SEVERITY_RANK[n.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0) ? n : best));
    lines.push(`Notice (${top.severity}): ${top.message}`);
  }
  lines.push("Tell the user about this in one line and SUGGEST `/ahood sync` and/or `npx @ahood/cli@latest setup`; do not run either yourself.");
  return lines.join(" ");
}

/** The hook's decision for one SessionStart event: the JSON to print, or null to print nothing. */
export function decide(input, env) {
  if (!input || input.hook_event_name !== "SessionStart") return null;
  const path = cachePath(env);
  if (!isStale(readCache(path))) return null; // at most once per 24h -- nothing new to say this session
  writeCache(path);
  const context = buildContext(runStatus(env));
  if (!context) return null;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return;
  }
  const out = decide(input, process.env);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    // A hook failure must never get in the way of starting the session.
  }
  process.exitCode = 0;
}
