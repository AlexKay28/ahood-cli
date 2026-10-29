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

export type SetupPlan = {
  files: FileChange[];
  commands: PlannedCommand[];
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
 */
export type SetupOptions = { yes: boolean; token: string | null };

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
}

export function emptyPlan(): SetupPlan {
  return { files: [], commands: [], manual: [], notes: [] };
}
