import { clearCredentials } from "../credentials.js";

import { parseArgs } from "../flags.js";

// Takes its args only to refuse them: index.ts used to drop them, so
// `ahood logout --bogus` cleared the stored token anyway (ahood-cli#260).
export async function logout(args: string[] = []): Promise<void> {
  parseArgs(args, { usage: "Usage: ahood logout", booleans: ["--json"], max: 0 });
  clearCredentials();
  console.log("Logged out.");
}
