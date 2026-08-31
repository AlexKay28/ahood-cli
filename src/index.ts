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
import { listMine } from "./commands/list-mine.js";
import { star, unstar } from "./commands/star.js";
import { view } from "./commands/view.js";
import { completion } from "./commands/completion.js";
import { formatHelp, formatCommandHelp, findCommandHelp } from "./help.js";
import { ApiError, NetworkError } from "./http.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami,
  search,
  add,
  update,
  remove,
  publish,
  token,
  edit,
  unpublish,
  "list-mine": listMine,
  star,
  unstar,
  view,
  completion,
};

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

function closestCommand(input: string): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const name of Object.keys(COMMANDS)) {
    const distance = levenshtein(input, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return bestDistance <= 2 ? best : undefined;
}

// A hung/black-holed connection throws undici's generic TypeError("fetch
// failed") -- http.ts wraps that into NetworkError so it gets its own exit
// code here, distinct from a server-returned ApiError.
function exitCodeFor(error: unknown): number {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return 4;
    if (error.status === 404) return 5;
    return 2;
  }
  if (error instanceof NetworkError) return 6;
  return 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "--version" || command === "-v") {
    console.log(`${CLI_NAME} ${CLI_VERSION}`);
    return;
  }

  if (command === "help") {
    const sub = args[0];
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
    const suggestion = closestCommand(command);
    if (suggestion) console.error(`Did you mean '${suggestion}'?`);
    console.error("Run `ahood help` for a list of commands.");
    process.exit(2);
  }

  if (args.includes("--help") || args.includes("-h")) {
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

main();
