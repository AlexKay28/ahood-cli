// ahood#1552 step 5: the passive CLI update notifier.
//
// `ahood doctor` has always checked npm for a newer CLI, but only when a
// human thinks to run it. This module shares that check (`newer()`, moved
// here from src/setup/doctor-command.ts, which now imports it) and adds a
// passive version: one stderr line printed after a command's own output,
// built from a cache so a command almost never has to touch the network.
//
// Mechanics:
//   - `~/.ahood/update-check.json` (overridable, like installed.ts's
//     AHOOD_INSTALLED_FILE, via AHOOD_UPDATE_CHECK_FILE) holds
//     `{checked_at, latest}`, refreshed at most once per 24h.
//   - `maybeNotifyUpdate()` is synchronous and does no network I/O itself: it
//     reads the cache, and -- only when the cache is stale -- fires a
//     detached, unref'd child process (`spawnBackgroundRefresh`) that does
//     the actual npm lookup (1.5s timeout) and writes the cache for NEXT
//     time. Because the refresh is detached and unref'd, this process exits
//     the moment its own work is done regardless of whether that child's
//     fetch has finished, timed out, or even started -- the notifier can
//     never delay a command's exit.
//   - Suppressed entirely (no read, no refresh, no line) for `--json`
//     output, a non-TTY stderr (piped/redirected), `CI=1` (or any other
//     truthy CI value) and AHOOD_NO_UPDATE_NOTIFIER=1.
//   - "required" instead of "available" wording is for the server's
//     `ahood_status` response saying `ahood.client.below_minimum` (web
//     issue #1552 step 4) -- that field may not exist on the server yet, so
//     every caller treats it as optional (undefined/absent = not required).
//     `ahood status` is the one command positioned to pass it through: see
//     src/commands/status.ts.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./lockfile.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

export const UPDATE_CHECK_FILE_ENV = "AHOOD_UPDATE_CHECK_FILE";
export const NO_UPDATE_NOTIFIER_ENV = "AHOOD_NO_UPDATE_NOTIFIER";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 1_500;
export const NPM_LATEST_URL = "https://registry.npmjs.org/@ahood%2fcli/latest";
/** The hidden, undocumented subcommand the detached background refresh runs. Never shown in help/suggestions. */
export const REFRESH_COMMAND = "__update-check-refresh";
// Matches web's lib/client-versions.ts SHARED_CLIENT_ENTRY.changelogUrl exactly.
const CHANGELOG_URL = "https://www.ahood.dev/changelog";

export type UpdateCheckCache = { checked_at: string; latest: string | null };

export function updateCheckFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env[UPDATE_CHECK_FILE_ENV] || join(homedir(), ".ahood", "update-check.json");
}

/** doctor's own semver-ish comparator (moved here, ahood#1552 step 5: shared with the passive notifier). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** A corrupt or missing cache reads as "no cache" -- a passive notifier must never throw and break a command. */
export function readUpdateCheckCache(path: string): UpdateCheckCache | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { checked_at?: unknown }).checked_at !== "string") return null;
    const latest = (parsed as { latest?: unknown }).latest;
    return { checked_at: (parsed as { checked_at: string }).checked_at, latest: typeof latest === "string" ? latest : null };
  } catch {
    return null;
  }
}

export function isStale(cache: UpdateCheckCache | null, now: number = Date.now()): boolean {
  if (!cache) return true;
  const checkedAt = Date.parse(cache.checked_at);
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * The actual npm lookup: at most `timeoutMs`, never throws. Writes the
 * cache unconditionally (even on failure, with `latest: null`) so a flaky
 * network doesn't retry on every single command for the next 24h -- the
 * same backoff shape `isStale` already gives every other cached check in
 * this CLI. Exported for the hidden refresh subcommand and for direct
 * (non-spawned) testing.
 */
export async function performRefresh(path: string, timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS): Promise<void> {
  let latest: string | null = null;
  try {
    const response = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      const body: unknown = await response.json();
      const version = (body as { version?: unknown } | undefined)?.version;
      if (typeof version === "string") latest = version;
    }
  } catch {
    // Best-effort: the next stale check tries again.
  }
  writeJsonFileAtomic(path, { checked_at: new Date().toISOString(), latest });
}

/**
 * Fires the detached, unref'd child that runs `performRefresh` for `path`
 * and returns immediately -- never awaited, never blocks. `process.argv[1]`
 * (this CLI's own entry file) is reused rather than a second binary, so the
 * child is exactly this CLI invoked with the hidden REFRESH_COMMAND.
 */
export function spawnBackgroundRefresh(path: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    const child = spawn(process.execPath, [entry, REFRESH_COMMAND, path], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Best-effort: no refresh this time, no crash either.
  }
}

export type SuppressionInput = { json?: boolean; env: NodeJS.ProcessEnv; isTTY: boolean };

function truthyCi(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** `--json`, a non-TTY stderr (piped/redirected), CI, or the explicit opt-out -- any one of these is enough. */
export function isSuppressed({ json, env, isTTY }: SuppressionInput): boolean {
  if (json) return true;
  if (!isTTY) return true;
  if (truthyCi(env.CI)) return true;
  if (env[NO_UPDATE_NOTIFIER_ENV] === "1") return true;
  return false;
}

export function noticeLine(opts: { current: string; latest: string; belowMinimum: boolean }): string {
  const verb = opts.belowMinimum ? "required" : "available";
  return `${CLI_NAME} ${opts.current} → ${opts.latest} ${verb}: npx ${CLI_NAME}@latest setup (changelog: ${CHANGELOG_URL})`;
}

export type NotifyOptions = {
  /** The current command's own --json flag; always suppresses when true. */
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: number;
  isTTY?: boolean;
  cliVersion?: string;
  /** Set by a caller that has a live `ahood.client.below_minimum` from the server (optional, may not exist yet). */
  belowMinimum?: boolean;
  /** Set by a caller with a fresher "latest" than the cache (e.g. `ahood status`'s own response). Falls back to the cache. */
  latest?: string | null;
};

/**
 * The one entry point every command calls after printing its own output.
 * Synchronous and side-effect-light by construction (see module doc): it
 * never awaits network I/O, so it can never delay a command's exit.
 */
export function maybeNotifyUpdate(opts: NotifyOptions = {}): void {
  try {
    const env = opts.env ?? process.env;
    const isTTY = opts.isTTY ?? Boolean(process.stderr.isTTY);
    if (isSuppressed({ json: opts.json, env, isTTY })) return;

    const path = updateCheckFilePath(env);
    const cache = readUpdateCheckCache(path);
    const now = opts.now ?? Date.now();
    if (isStale(cache, now)) spawnBackgroundRefresh(path);

    const latest = opts.latest !== undefined ? opts.latest : cache?.latest ?? null;
    if (!latest) return;
    const current = opts.cliVersion ?? CLI_VERSION;
    const belowMinimum = opts.belowMinimum ?? false;
    if (belowMinimum || newer(latest, current)) {
      console.error(noticeLine({ current, latest, belowMinimum }));
    }
  } catch {
    // A notifier failure must never surface as a command failure.
  }
}
