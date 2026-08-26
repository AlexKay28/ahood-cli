#!/usr/bin/env node
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";
import { search } from "./commands/search.js";
import { add } from "./commands/add.js";
import { update } from "./commands/update.js";
import { remove } from "./commands/remove.js";
import { publish } from "./commands/publish.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami: () => whoami(),
  search: (args) => search(args),
  add: (args) => add(args),
  update: (args) => update(args),
  remove: (args) => remove(args),
  publish: (args) => publish(args),
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command ?? "(none)"}\nAvailable: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(1);
  }
  try {
    await handler(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
