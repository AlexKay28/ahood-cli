import { clearCredentials } from "../credentials.js";

import { parseArgs } from "../flags.js";
import { printJson } from "../json-output.js";

// Takes its args only to refuse them: index.ts used to drop them, so
// `ahood logout --bogus` cleared the stored token anyway (ahood-cli#260).
export async function logout(args: string[] = []): Promise<void> {
  const parsed = parseArgs(args, { usage: "Usage: ahood logout [--json]", booleans: ["--json"], max: 0 });
  clearCredentials();
  if (parsed.has("--json")) {
    printJson({ logged_out: true });
    return;
  }
  console.log("Logged out.");
}
