#!/usr/bin/env node
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami: () => whoami(),
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
