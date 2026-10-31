// The contract every harness module implements (ahood#980). A harness module
// only inspects and plans; commands/setup.ts asks for consent and applies,
// commands/doctor.ts reports. Adding a harness is one module plus one line in
// harnesses/index.ts.
import type { FileChange } from "../file-changes.js";

export const HARNESS_IDS = ["claude", "codex", "opencode"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

export type Detection = {
  /** The harness's CLI on PATH, if any. */
  binary: string | null;
  /** Its user config dir, and whether that exists. */
  configDir: string;
  configDirExists: boolean;
  /** Either signal counts: a CLI on PATH, or its config dir. */
  installed: boolean;
};

/** A program setup runs for the user (only with their consent). */
export type PlannedCommand = { bin: string; args: string[]; what: string };

/**
 * A file edit that can only be planned once the commands have run, because
 * one of them rewrites that file (claude's `plugin marketplace add` re-writes
 * the marketplace declaration in settings.json, dropping `autoUpdate`).
 * `what` is shown in the preview; `plan` reads the file as the commands left it.
 */
export type DeferredChange = { path: string; what: string; plan(): FileChange | null };

export type SetupPlan = {
  files: FileChange[];
  commands: PlannedCommand[];
  /** Applied, through the same writer as `files`, after every command succeeded. */
  afterCommands: DeferredChange[];
  /** Steps the user has to do by hand (e.g. typed inside a Claude Code session). */
  manual: string[];
  notes: string[];
};

/**
 * One feature a harness's setup writes (an MCP entry, a skill, command
 * files, ...), or an independent opt-in extra (the Claude Code snap hook).
 * `optional: true` means `absent` is the expected default, not a gap --
 * `ahood doctor` shows it as skipped rather than failed, even when the rest
 * of this harness's setup is in place.
 */
export type Feature = { name: string; state: "absent" | "ok" | "stale" | "partial" | "broken"; detail: string; optional?: boolean };

/** Whether OUR config is in place for doctor: `absent` = never set up (not a failure). */
export type ConfigState = {
  state: "absent" | "ok" | "stale" | "partial" | "broken";
  details: string[];
  features: Feature[];
  /** True when `ahood setup` stored the ahood token in this harness's config (ahood#990). */
  tokenStored?: boolean;
};

/**
 * `token`: the ahood token to store in the harness's own config -- set only
 * after the user consented (ahood#990, decision B). null = the config names
 * $AHOOD_TOKEN instead, and any token setup stored earlier is taken out.
 * `releaseBranch`: whether GitHub has the `release` branch the plugin is
 * installed from (ahood#1018 step B) -- false refuses, null = could not ask.
 * `autoUpdate`: the user agreed to background plugin updates (ahood#1018
 * step C); only a harness with `autoUpdateConsent` acts on it.
 */
export type SetupOptions = { yes: boolean; token: string | null; releaseBranch: boolean | null; autoUpdate: boolean };

/**
 * A harness whose config can hold the token itself. `file` is the one file
 * the token goes into (so setup can check its permissions first); `stored`
 * is the token setup already put there, if any; `userSet` whether the user
 * set one there themselves (then setup leaves it alone).
 */
export type TokenStore = { file(): string; stored(): string | null; userSet(): boolean; what: string };

export interface Harness {
  id: HarnessId;
  label: string;
  detect(): Detection;
  planSetup(opts: SetupOptions): SetupPlan;
  planRemove(): SetupPlan;
  inspect(): ConfigState;
  tokenStore?: TokenStore;
  /**
   * A harness whose background plugin updates are off until the user turns
   * them on (Claude Code, for a third-party marketplace): setup asks once,
   * and `enabled` says whether they are on already (then it does not ask).
   */
  autoUpdateConsent?: { enabled(): boolean; question: string };
  /**
   * An npm package the harness installs by itself when it starts (the opencode
   * plugin). `ahood doctor` checks npm has it at this CLI's version, because a
   * harness that cannot install it may skip it without saying so.
   */
  npmPackage?: string;
}

export function emptyPlan(): SetupPlan {
  return { files: [], commands: [], afterCommands: [], manual: [], notes: [] };
}
