#!/usr/bin/env node
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";
import { search } from "./commands/search.js";
import { add } from "./commands/add.js";
import { update } from "./commands/update.js";
import { remove } from "./commands/remove.js";
import { publish } from "./commands/publish.js";
import { token } from "./commands/token.js";
import { edit } from "./commands/edit.js";
import { unpublish } from "./commands/unpublish.js";
import { listSkills } from "./commands/list.js";
import { star, unstar } from "./commands/star.js";
import { view } from "./commands/view.js";
import { versions } from "./commands/versions.js";
import { completion } from "./commands/completion.js";
import { init } from "./commands/init.js";
import { formatHelp, formatSkillHelp, formatCommandHelp, findCommandHelp } from "./help.js";
import { ApiError } from "./http.js";
import { exitCodeFor } from "./exit-code.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

// Every skill-entity verb, reached only as `ahood skill <verb>` -- see
// dispatchSkill() below. "show" is an alias for "view" (issue #30).
const SKILL_COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  search,
  view,
  show: view,
  versions,
  list: listSkills,
  add,
  update,
  remove,
  edit,
  unpublish,
  star,
  unstar,
  init,
  publish,
};

// Top level is now just account/auth-scoped commands (not entity-specific --
// same reasoning `gh auth login` isn't `gh account login`) plus the `skill`
// entity group. Future entities (e.g. "personality", "protocols") get their
// own entry here alongside "skill".
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami,
  token,
  completion,
  skill: dispatchSkill,
};

// Commands whose handler owns its own --help handling (at both the group
// level, e.g. `ahood skill --help`, and the per-verb level, e.g.
// `ahood skill add --help`) instead of the generic top-level interception
// in main().
const GROUP_COMMANDS = new Set(["skill"]);

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function closestOf(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const name of candidates) {
    const distance = levenshtein(input, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return bestDistance <= 2 ? best : undefined;
}

function closestCommand(input: string): string | undefined {
  return closestOf(input, Object.keys(COMMANDS));
}

function closestSkillCommand(input: string): string | undefined {
  return closestOf(input, Object.keys(SKILL_COMMANDS));
}

// `ahood skill <verb> [...]` -- owns its own help handling at both the
// group level (`ahood skill` / `ahood skill --help`) and the per-verb level
// (`ahood skill <verb> --help`), since neither should fall through to
// main()'s generic top-level --help interception (see GROUP_COMMANDS).
async function dispatchSkill(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(formatSkillHelp());
    return;
  }

  const handler = SKILL_COMMANDS[sub];
  if (!handler) {
    console.error(`Unknown skill command: ${sub}`);
    const suggestion = closestSkillCommand(sub);
    if (suggestion) console.error(`Did you mean '${suggestion}'?`);
    console.error("Run `ahood skill --help` for a list of commands.");
    process.exit(2);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    const entry = findCommandHelp("skill", sub);
    console.log(entry ? formatCommandHelp(entry) : formatSkillHelp());
    return;
  }

  await handler(rest);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "--version" || command === "-v") {
    console.log(`${CLI_NAME} ${CLI_VERSION}`);
    return;
  }

  if (command === "help") {
    const sub = args[0];
    if (sub === "skill") {
      const verb = args[1];
      const entry = verb ? findCommandHelp("skill", verb) : undefined;
      console.log(entry ? formatCommandHelp(entry) : formatSkillHelp());
      return;
    }
    const entry = sub ? findCommandHelp(sub) : undefined;
    console.log(entry ? formatCommandHelp(entry) : formatHelp());
    return;
  }

  // Bare invocation and an explicit help request both just want to see
  // what's available -- neither is an error.
  if (!command || command === "--help" || command === "-h") {
    console.log(formatHelp());
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    // Every previously-flat skill command moved under `ahood skill <verb>`
    // in this release -- if the typo looks like one of those, point at the
    // new form specifically rather than just the generic top-level list.
    const skillSuggestion = closestSkillCommand(command);
    if (skillSuggestion) {
      console.error(`Did you mean 'ahood skill ${skillSuggestion}'?`);
    } else {
      const suggestion = closestCommand(command);
      if (suggestion) console.error(`Did you mean '${suggestion}'?`);
    }
    console.error("Run `ahood help` for a list of commands.");
    process.exit(2);
  }

  // Group commands (currently just "skill") own their own --help handling
  // at both the group and per-verb level -- don't intercept here.
  if (!GROUP_COMMANDS.has(command) && (args.includes("--help") || args.includes("-h"))) {
    const entry = findCommandHelp(command);
    console.log(entry ? formatCommandHelp(entry) : formatHelp());
    return;
  }

  try {
    await handler(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      console.error("Run `ahood login` first (or set AHOOD_TOKEN).");
    }
    process.exit(exitCodeFor(error));
  }
}

// Only auto-run when this module is the actual entrypoint (i.e. invoked as
// `ahood ...` / `node dist/index.js ...`), not when it's imported by a test
// -- process.argv[1] is dist/index.js in the former case, something else
// (the test runner) in the latter.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main();
}

// Exported for tests only -- the CLI itself only ever calls main() above.
export { main, dispatchSkill, COMMANDS, SKILL_COMMANDS };
