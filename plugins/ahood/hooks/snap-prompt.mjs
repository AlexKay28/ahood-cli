#!/usr/bin/env node
// ahood's opt-in snap prompt, a Claude Code Stop hook (ahood#981).
//
// OFF unless the environment Claude Code runs in has AHOOD_SNAP_HOOK=1. Off,
// it reads nothing, prints nothing and exits 0, so the session ends exactly
// as if the hook were not there.
//
// On, the first time a turn ends in a session it answers
// {"decision":"block","reason":...}: Claude Code then keeps the turn going
// with `reason` as the instruction, which is to draft a structured snap, show
// it, and ask the user before saving. The hook itself never saves or sends
// anything -- it has no network access (it imports node:fs, node:os, node:path and
// node:url only) and never runs the ahood CLI. Saving stays a separate step
// the user must agree to, and Claude Code asks permission for it again.
//
// It asks at most once per session (a marker file named after the session id
// under $CLAUDE_PLUGIN_DATA, or the OS temp dir), and never while
// stop_hook_active is true, i.e. while Claude is already continuing because
// of a Stop hook -- the guard Claude Code 2.1.282 itself names when it
// overrides a looping Stop hook.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const ENABLE_ENV = "AHOOD_SNAP_HOOK";

export const SNAP_PROMPT = [
  "ahood snap hook (opt-in): before ending, offer the user a private ahood snap of this session.",
  "If nothing here is worth keeping (no deliverable handed over, no correction from the user), end your turn without asking.",
  "Otherwise draft it: a one-line summary plus failed / worked / fix / lesson (no names or private details) /",
  "artifact (owner/slug, if one ahood skill, agent or MCP server was involved). Leave out secrets.",
  "Show the draft and ask whether to save it. Save only on the user's explicit yes, with",
  '`ahood snap create "<summary>" --failed "..." --worked "..." --fix "..." --lesson "..." --artifact <owner/slug>`',
  "or the ahood MCP tool create_snap. Do not save it in this turn: wait for the answer.",
].join(" ");

/** True only for AHOOD_SNAP_HOOK=1: any other value, or none, leaves the hook off. */
export function isEnabled(env) {
  return env[ENABLE_ENV] === "1";
}

function markerPath(env, sessionId) {
  const dir = env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "ahood-snap-hook");
  return join(dir, `prompted-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}`);
}

/** The hook's decision for one Stop event: the JSON to print, or null to print nothing. */
export function decide(input, env) {
  if (!isEnabled(env)) return null;
  if (!input || input.hook_event_name !== "Stop" || input.stop_hook_active === true) return null;
  if (!input.session_id) return null;
  const marker = markerPath(env, input.session_id);
  if (existsSync(marker)) return null;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "");
  } catch {
    // No marker means no once-per-session guarantee, so ask nothing at all.
    return null;
  }
  return { decision: "block", reason: SNAP_PROMPT };
}

function main() {
  // Off: return before reading stdin, so the disabled hook does no work.
  if (!isEnabled(process.env)) return;
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
    // A hook failure must never get in the way of ending the session.
  }
  process.exitCode = 0;
}
