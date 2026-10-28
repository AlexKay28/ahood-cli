// Every harness `ahood setup` / `ahood doctor` know, in the order they are offered.
import { claudeHarness } from "./claude.js";
import { codexHarness } from "./codex.js";
import { opencodeHarness } from "./opencode.js";
import type { Harness, HarnessId } from "./types.js";

export const HARNESSES: Record<HarnessId, Harness> = {
  claude: claudeHarness,
  codex: codexHarness,
  opencode: opencodeHarness,
};
