import { createInterface } from "node:readline";
import { UsageError } from "./usage-error.js";

// How long a prompt waits on a stdin that is NOT a terminal. A pipe that is
// open but silent is the normal stdin under agent and CI runners, and
// readline waits on it forever -- `sleep 20 | ahood skill remove a/b` printed
// the prompt and sat there until something killed it (ahood-cli#257), against
// this CLI's "must never hang" rule. Refusing a non-TTY outright would have
// broken `echo yes | ahood ...`, so the pipe is read, but only for this long:
// a piped answer is already in the buffer and arrives within milliseconds,
// so a few seconds is slack for a slow producer, not a wait anyone should
// feel. A real terminal is never bounded -- a human is allowed to think.
export const NON_TTY_ANSWER_TIMEOUT_MS = 3000;

// A prompt nobody answered: stdin closed, or stayed silent for the bound
// above. A UsageError (exit 2) because the fix is in the invocation -- pass
// the flag or export the variable the message names -- and its own subclass
// so a caller can tell "nobody is there" apart from a real failure.
//
// `reason` is kept apart from the message for the caller that has to write
// its own: add.ts names the variable to export, which a prompt cannot know.
export class PromptUnansweredError extends UsageError {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

// Streams already proven to have nobody behind them. One command can prompt
// several times (one per MCP secret): without this, every later prompt would
// wait out the full bound again on a pipe that has already shown it is
// silent.
const unanswerable = new WeakSet<object>();

// One line from stdin, shared by every prompt here and by promptSecret's
// non-TTY branch so they cannot drift apart on the two ways a prompt goes
// unanswered. `unanswered` builds the message from the reason, because only
// the caller knows the remedy (--yes for a confirmation, an env var for a
// secret).
//
// On closed stdin, readline/promises' rl.question() promise never settles --
// but since nothing else keeps the event loop alive at that point, the
// process used to exit 0 anyway once the loop drained, having printed only
// the prompt (no "Aborted.", no deletion, no error: a silent false success).
// The plain callback-style API is used instead specifically so the "close"
// listener can be a reliable signal for "closed without ever answering":
// `settled` is set synchronously inside the answer callback, before
// rl.close() is called, so that same close doesn't self-reject.
export function questionLine(promptText: string, unanswered: (reason: string) => string): Promise<string> {
  const stdin = process.stdin;
  // readableEnded/destroyed: on a stream that has already ended, "close"
  // never fires again, so the promise below would never settle -- the same
  // silent false success described above, one prompt later.
  if (unanswerable.has(stdin) || stdin.readableEnded || stdin.destroyed) {
    return Promise.reject(new PromptUnansweredError(unanswered("stdin closed"), "stdin closed"));
  }
  // A piped stdin is a socket, and rl.close() pausing it is not enough to let
  // go of the event loop: `(echo yes; sleep 60) | ahood skill remove a/b`
  // removed the skill and then sat there until the writer went away. Unref'd
  // once the prompt is over (and ref'd again here, for a later prompt) so an
  // answered prompt cannot hang the process any more than an unanswered one.
  // Optional calls: a redirected file has neither method, and just ends.
  const pipe = stdin.isTTY ? undefined : (stdin as { ref?: () => void; unref?: () => void });
  pipe?.ref?.();
  const rl = createInterface({ input: stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const giveUp = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pipe?.unref?.();
      unanswerable.add(stdin);
      // The prompt was written without a newline; end that line so the error
      // doesn't land glued to the end of the question.
      process.stdout.write("\n");
      reject(new PromptUnansweredError(unanswered(reason), reason));
    };
    rl.once("close", () => giveUp("stdin closed"));
    if (!stdin.isTTY) {
      timer = setTimeout(() => {
        giveUp(`no terminal, and nothing arrived on stdin within ${NON_TTY_ANSWER_TIMEOUT_MS / 1000}s`);
        rl.close();
      }, NON_TTY_ANSWER_TIMEOUT_MS);
    }
    rl.question(promptText, (answer) => {
      settled = true;
      clearTimeout(timer);
      rl.close();
      pipe?.unref?.();
      resolve(answer);
    });
  });
}

// Shared by any command that needs a "Type yes to confirm" prompt before a
// destructive/irreversible action (unpublish's whole-skill delete and
// per-version yank, token revoke, ...) so they all get the same TTY-safe
// behavior instead of each reimplementing it slightly differently. Every
// caller skips this prompt on --yes, which is why the message can name it.
export async function confirm(promptText: string): Promise<boolean> {
  const answer = await questionLine(
    promptText,
    (reason) => `Confirmation was not answered (${reason}) -- pass --yes to confirm without a prompt.`,
  );
  return answer.trim().toLowerCase() === "yes";
}

// One free-text answer, with the same guarantees as confirm() above: a stdin
// that closes or stays silent rejects instead of hanging or silently
// resolving. Used by the per-item prompts of `ahood sync` and `ahood review`
// (ahood#979).
export async function askLine(promptText: string): Promise<string> {
  return (await questionLine(promptText, (reason) => `Prompt was not answered (${reason}).`)).trim();
}

// A y/N question: only "y" or "yes" (any case) is consent; anything else,
// including an empty answer, is no.
export async function confirmYesNo(promptText: string): Promise<boolean> {
  const answer = (await askLine(promptText)).toLowerCase();
  return answer === "y" || answer === "yes";
}

// Whether a per-item prompt can be shown at all: stdin and stdout both a
// terminal. Piped or redirected, there is nobody to answer.
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
