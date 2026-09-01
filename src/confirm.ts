import { createInterface } from "node:readline";

// On closed/non-interactive stdin, readline/promises' rl.question() promise
// never settles -- but since nothing else keeps the event loop alive at that
// point, the process used to exit 0 anyway once the loop drained, having
// printed only the prompt (no "Aborted.", no deletion, no error: a silent
// false success). The plain callback-style API is used instead specifically
// so the "close" listener can be a reliable signal for "closed without ever
// answering": `settled` is set synchronously inside the answer callback,
// before rl.close() is called, so that same close doesn't self-reject.
//
// Shared by any command that needs a "Type yes to confirm" prompt before a
// destructive/irreversible action (unpublish's whole-skill delete and
// per-version yank, token revoke, ...) so they all get the same TTY-safe
// behavior instead of each reimplementing it slightly differently.
export function confirm(promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let settled = false;
    rl.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Confirmation was not answered (stdin closed)."));
    });
    rl.question(promptText, (answer) => {
      settled = true;
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}
