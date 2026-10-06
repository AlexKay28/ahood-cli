#!/usr/bin/env node
import { realpathSync } from "node:fs";
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
import { share, unshare } from "./commands/share.js";
import { view } from "./commands/view.js";
import { read } from "./commands/read.js";
import { versions } from "./commands/versions.js";
import { diff } from "./commands/diff.js";
import { completion } from "./commands/completion.js";
import { mcp } from "./commands/mcp.js";
import { extractKindFlag, resolveScope, type CliKind, type KindScope } from "./kinds.js";
import { readUseme } from "./useme.js";
import { UsageError } from "./usage-error.js";
import { init } from "./commands/init.js";
import {
  createGroup,
  listGroups,
  groupMembers,
  inviteLink,
  joinGroup,
  removeMember,
  leaveGroup,
  deleteGroup,
} from "./commands/group.js";
import {
  createSnap,
  listSnaps,
  searchSnaps,
  showSnap,
  removeSnap,
  shareSnap,
  unshareSnap,
  tagsSnap,
} from "./commands/snap.js";
import { formatHelp, formatKindHelp, formatGroupHelp, formatSnapHelp, formatCommandHelp, findCommandHelp } from "./help.js";
import { ApiError } from "./http.js";
import { exitCodeFor } from "./exit-code.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

// Every registry verb, reached as `ahood skill <verb>`, `ahood agent <verb>`,
// or `ahood mcp <verb>` -- one handler per verb shared by all three nouns
// (see dispatchRegistry() below), never a copy per kind. "show" is an alias
// for "view" (issue #30). A handler gets a second, KindScope argument only
// when the verb runs kind-scoped; the legacy `ahood skill <verb>` call is
// exactly `handler(args)`, as it was before ahood-cli#172.
type RegistryHandler = (args: string[], scope?: KindScope) => Promise<void>;

const SKILL_COMMANDS: Record<string, RegistryHandler> = {
  search,
  view,
  show: view,
  read,
  versions,
  diff,
  list: listSkills,
  add,
  update,
  // A discoverable name for what `update --dry-run` already does (ahood-cli#91)
  // -- forces --dry-run regardless of what the caller passes, so `outdated`
  // can never accidentally move a pin forward. Reuses update()'s existing
  // "no targets = every installed skill, explicit targets = just those"
  // behavior as-is; no new logic.
  outdated: (args, scope) => (scope ? update([...args, "--dry-run"], scope) : update([...args, "--dry-run"])),
  remove,
  edit,
  unpublish,
  star,
  unstar,
  share,
  unshare,
  init,
  publish,
};

// Every group-entity verb, reached only as `ahood group <verb>` -- see
// dispatchGroup() below. Named GROUP_VERBS (not GROUP_COMMANDS) specifically
// to avoid colliding with the pre-existing GROUP_COMMANDS Set below, which
// means something unrelated ("entities that own their own sub-dispatch").
const GROUP_VERBS: Record<string, (args: string[]) => Promise<void>> = {
  create: createGroup,
  list: listGroups,
  members: groupMembers,
  "invite-link": inviteLink,
  join: joinGroup,
  "remove-member": removeMember,
  leave: leaveGroup,
  delete: deleteGroup,
};

// Every snap-entity verb, reached only as `ahood snap <verb>` -- see
// dispatchSnap() below. Mirrors GROUP_VERBS above exactly; a snap is a pure
// API-client entity like a group, with no local filesystem footprint.
const SNAP_VERBS: Record<string, (args: string[]) => Promise<void>> = {
  create: createSnap,
  list: listSnaps,
  search: searchSnaps,
  show: showSnap,
  remove: removeSnap,
  share: shareSnap,
  unshare: unshareSnap,
  tags: tagsSnap,
};

// Top level is now just account/auth-scoped commands (not entity-specific --
// same reasoning `gh auth login` isn't `gh account login`) plus the `skill`,
// `group`, and `snap` entity groups. Future entities get their own entry
// here alongside these.
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami,
  token,
  completion,
  mcp: dispatchMcp,
  skill: dispatchSkill,
  agent: dispatchAgent,
  group: dispatchGroup,
  snap: dispatchSnap,
};

// Commands whose handler owns its own --help handling (at both the group
// level, e.g. `ahood skill --help` / `ahood group --help`, and the per-verb
// level, e.g. `ahood skill add --help` / `ahood group create --help`)
// instead of the generic top-level interception in main(). Despite the
// name, this Set has nothing to do with the "Groups" feature -- "group"
// here just means "a command that owns its own sub-verb dispatch", the same
// sense "skill" already used before "group" (the entity) existed. "snap"
// joins this set for the exact same reason (ahood-cli#107).
// "agent" and "mcp" join it as registry nouns (ahood-cli#172).
const GROUP_COMMANDS = new Set(["skill", "agent", "mcp", "group", "snap"]);

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

function closestGroupVerb(input: string): string | undefined {
  return closestOf(input, Object.keys(GROUP_VERBS));
}

function closestSnapVerb(input: string): string | undefined {
  return closestOf(input, Object.keys(SNAP_VERBS));
}

// `ahood <noun> <verb> [...]` for every registry noun (skill, agent, mcp) --
// owns its own help handling at both the noun level (`ahood agent` /
// `ahood agent --help`) and the per-verb level (`ahood agent <verb> --help`),
// since neither should fall through to main()'s generic top-level --help
// interception (see GROUP_COMMANDS).
//
// Scope (ahood-cli#172): `--kind <k|all>` is consumed here, never by a
// handler, and resolved by resolveScope(): agent/mcp are strict for their own
// kind (a contradictory --kind is a usage error), while skill stays legacy
// cross-kind unless --kind narrows it. `ahood skill publish` is the one
// exception: its --kind has always been publish's own "what kind of artifact
// is this folder" flag, so it is passed through untouched.
async function dispatchRegistry(noun: CliKind, args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(formatKindHelp(noun));
    return;
  }

  const handler = SKILL_COMMANDS[sub];
  if (!handler) {
    console.error(`Unknown ${noun} command: ${sub}`);
    const suggestion = closestOf(sub, noun === "mcp" ? ["serve", ...Object.keys(SKILL_COMMANDS)] : Object.keys(SKILL_COMMANDS));
    if (suggestion) console.error(`Did you mean '${suggestion}'?`);
    console.error(`Run \`ahood ${noun} --help\` for a list of commands.`);
    if (noun === "mcp") {
      console.error("To start the local MCP server, run `ahood mcp serve` (or `ahood mcp` with no arguments).");
    }
    process.exit(2);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    const entry = findCommandHelp(noun, sub);
    console.log(entry ? formatCommandHelp(entry) : formatKindHelp(noun));
    return;
  }

  if (noun === "skill" && sub === "publish") {
    await handler(rest);
    return;
  }

  const { kind, rest: handlerArgs } = extractKindFlag(rest);
  const scope = resolveScope(noun, kind);
  if (scope.kind === "all") {
    // Legacy: the exact pre-#172 call, minus an explicit `--kind all`.
    await handler(kind === undefined ? rest : handlerArgs);
    return;
  }
  try {
    await handler(handlerArgs, scope);
  } catch (error) {
    // Handlers phrase their usage lines as `ahood skill <verb>`; under another
    // noun, say the command the user actually typed.
    if (error instanceof UsageError && noun !== "skill") {
      error.message = error.message.replace(/(Usage: |or: )ahood skill /g, `$1ahood ${noun} `);
    }
    throw error;
  }
}

async function dispatchSkill(args: string[]): Promise<void> {
  await dispatchRegistry("skill", args);
}

async function dispatchAgent(args: string[]): Promise<void> {
  await dispatchRegistry("agent", args);
}

// `ahood mcp` keeps its original contract byte-for-byte: with NO arguments it
// is the local stdio MCP server that existing host configs launch -- nothing
// is printed and nothing else runs first. `ahood mcp serve` is the same
// server under an explicit, documented name. Every other first word is a
// registry verb for mcp-kind entries, help, or an error: an unrecognized one
// fails with usage (dispatchRegistry) rather than silently starting a
// long-lived server that a typo would otherwise leave hanging.
async function dispatchMcp(args: string[]): Promise<void> {
  if (args.length === 0) {
    await mcp(args);
    return;
  }
  const [sub, ...rest] = args;
  if (sub === "serve") {
    if (rest.includes("--help") || rest.includes("-h")) {
      const entry = findCommandHelp("mcp", "serve");
      console.log(entry ? formatCommandHelp(entry) : formatKindHelp("mcp"));
      return;
    }
    if (rest.length > 0) {
      throw new UsageError(`\`ahood mcp serve\` takes no arguments (got: ${rest.join(" ")}).\nUsage: ahood mcp serve`);
    }
    await mcp([]);
    return;
  }
  await dispatchRegistry("mcp", args);
}

// `ahood group <verb> [...]` -- owns its own help handling at both the
// group level (`ahood group` / `ahood group --help`) and the per-verb level
// (`ahood group <verb> --help`), exactly mirroring dispatchSkill() above.
async function dispatchGroup(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(formatGroupHelp());
    return;
  }

  const handler = GROUP_VERBS[sub];
  if (!handler) {
    console.error(`Unknown group command: ${sub}`);
    const suggestion = closestGroupVerb(sub);
    if (suggestion) console.error(`Did you mean '${suggestion}'?`);
    console.error("Run `ahood group --help` for a list of commands.");
    process.exit(2);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    const entry = findCommandHelp("group", sub);
    console.log(entry ? formatCommandHelp(entry) : formatGroupHelp());
    return;
  }

  await handler(rest);
}

// `ahood snap <verb> [...]` -- owns its own help handling at both the
// group level (`ahood snap` / `ahood snap --help`) and the per-verb level
// (`ahood snap <verb> --help`), exactly mirroring dispatchSkill()/
// dispatchGroup() above.
async function dispatchSnap(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(formatSnapHelp());
    return;
  }

  const handler = SNAP_VERBS[sub];
  if (!handler) {
    console.error(`Unknown snap command: ${sub}`);
    const suggestion = closestSnapVerb(sub);
    if (suggestion) console.error(`Did you mean '${suggestion}'?`);
    console.error("Run `ahood snap --help` for a list of commands.");
    process.exit(2);
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    const entry = findCommandHelp("snap", sub);
    console.log(entry ? formatCommandHelp(entry) : formatSnapHelp());
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
    // `ahood help useme` (ahood-cli#172): the bundled self-skill, as raw
    // bytes on stdout and nothing else -- no banner, no trailing newline of
    // our own -- so the output IS the SKILL.md. No network, no credentials,
    // no project writes.
    if (sub === "useme") {
      let content: Buffer;
      try {
        content = readUseme();
      } catch (error) {
        console.error(`Could not read the bundled ahood SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      process.stdout.write(content);
      return;
    }
    if (sub === "skill" || sub === "agent" || sub === "mcp") {
      const verb = args[1];
      const entry = verb ? findCommandHelp(sub, verb) : undefined;
      console.log(entry ? formatCommandHelp(entry) : formatKindHelp(sub));
      return;
    }
    if (sub === "group") {
      const verb = args[1];
      const entry = verb ? findCommandHelp("group", verb) : undefined;
      console.log(entry ? formatCommandHelp(entry) : formatGroupHelp());
      return;
    }
    if (sub === "snap") {
      const verb = args[1];
      const entry = verb ? findCommandHelp("snap", verb) : undefined;
      console.log(entry ? formatCommandHelp(entry) : formatSnapHelp());
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

  // Entities with their own sub-dispatch ("skill", "group", "snap" --
  // GROUP_COMMANDS despite the name, unrelated to the "group" entity itself)
  // own their own --help handling at both the entity and per-verb level --
  // don't intercept here.
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
// (the test runner) in the latter. Comparing realpaths (not raw argv[1])
// is required here: npm's installed `ahood` binary is a symlink to
// dist/index.js, so process.argv[1] is the symlink's path while
// import.meta.url resolves through the symlink to the real file -- a raw
// string comparison never matches for any real npm-installed invocation,
// which silently skipped main() entirely (every command exited 0 with no
// output, since nothing ever ran).
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === `file://${realpathSync(process.argv[1])}`;
if (isEntrypoint) {
  main();
}

// Exported for tests only -- the CLI itself only ever calls main() above.
export { main, dispatchSkill, dispatchAgent, dispatchMcp, dispatchRegistry, dispatchGroup, dispatchSnap, COMMANDS, SKILL_COMMANDS, GROUP_VERBS, SNAP_VERBS };
