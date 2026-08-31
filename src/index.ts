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
import { formatHelp, findCommandHelp } from "./help.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami: () => whoami(),
  search: (args) => search(args),
  add: (args) => add(args),
  update: (args) => update(args),
  remove: (args) => remove(args),
  publish: (args) => publish(args),
  token: (args) => token(args),
  edit: (args) => edit(args),
  unpublish: (args) => unpublish(args),
  "list-mine": () => listMine(),
  star: (args) => star(args),
  unstar: (args) => unstar(args),
};

async function main() {
  const [command, ...args] = process.argv.slice(2);

  // Bare invocation and an explicit help request both just want to see
  // what's available -- neither is an error.
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(formatHelp());
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    console.error(formatHelp());
    process.exit(1);
  }

  if (args.includes("--help") || args.includes("-h")) {
    const entry = findCommandHelp(command);
    console.log(entry ? `${entry.usage}\n\n${entry.desc}` : formatHelp());
    return;
  }

  try {
    await handler(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // "Unauthorized" is the exact, literal body every resolveCaller-gated
    // route returns on a 401 (see lib/resolve-caller.ts's callers) -- the
    // one signal worth appending a next-step to, since every other error
    // message is already command-specific.
    if (/^unauthorized$/i.test(message)) {
      console.error("Run `ahood login` first (or set AHOOD_TOKEN).");
    }
    process.exit(1);
  }
}

main();
