import { UsageError } from "./usage-error.js";

// The `--json` contract, in one place (ahood-cli#251). Under --json a command
// writes exactly one JSON document to stdout and nothing else there: the
// result on success, `{error, exit_code}` on failure. Before this, write verbs
// accepted the flag and printed prose anyway (`group create Team --json`
// printed "Created group Team (team)." -- and an agent needs that slug for
// every later `group` call), and a failure left stdout empty for every command
// but two, which each had a shape of their own.

// Whether this invocation asked for JSON. Stops at a bare `--`, which ends
// flag parsing (flags.ts parseArgs): `snap create -- "--json broke"` is a note
// that mentions the flag, not a request for it.
export function jsonRequested(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).includes("--json");
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

// The failure document. `exit_code` repeats the process's own exit status
// (exit-code.ts) so a caller holding only captured stdout can still branch on
// the documented codes. Snake_case like every other key this CLI emits.
export type JsonError = { error: string; exit_code: number };

export function jsonError(message: string, exitCode: number): JsonError {
  return { error: message, exit_code: exitCode };
}

// confirm() (confirm.ts) asks on stdout, and stdout is promised to one JSON
// document -- so a confirming verb in JSON mode takes its consent from --yes or
// not at all, and is refused before any request. `ahood sync --json` already
// worked this way ("--json leaves no terminal to ask on"); this is that rule
// for every other verb that prompts. Lives here, not in confirm.ts, because
// half the test suite replaces that module wholesale to answer the prompt.
export function assertJsonHasConsent(json: boolean, yes: boolean, usage: string): void {
  if (json && !yes) {
    throw new UsageError(`--json leaves no terminal to ask on, so it needs --yes to confirm.\n${usage}`);
  }
}

// Runs an install/scaffold step whose progress lines are written with
// console.log deep inside shared code (add.ts's four install paths, also
// reached by update and sync), sending them to stderr so stdout stays one
// document. The same swap sync.ts's applyInProject has always done for its own
// --json mode, lifted here so `add --json` doesn't grow a second copy.
export async function withProseOnStderr<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const log = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}
