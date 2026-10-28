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

/** Whether OUR config is in place for doctor: `absent` = never set up (not a failure). */
export type ConfigState = { state: "absent" | "ok" | "stale" | "partial" | "broken"; details: string[] };

export type SetupOptions = { yes: boolean };

export interface Harness {
  id: HarnessId;
  label: string;
  detect(): Detection;
  planSetup(opts: SetupOptions): SetupPlan;
  planRemove(): SetupPlan;
  inspect(): ConfigState;
}

export function emptyPlan(): SetupPlan {
  return { files: [], commands: [], manual: [], notes: [] };
}
