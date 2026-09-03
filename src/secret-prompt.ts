import { createInterface } from "node:readline";

// Masked secret-value prompt, extending confirm.ts's TTY-safe "close" race
// (see confirm.ts's own comment): the same closed-stdin-never-resolves
// problem, and the same fix -- a "close" listener rejects if it fires
// before an answer is captured. Kept as its own module rather than folded
// into confirm.ts because that module's contract is yes/no, not a typed
// value, and because masking requires raw-mode keystroke handling that a
// plain rl.question() call cannot do (readline always echoes verbatim when
// its input is a TTY).
export function promptSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    // Non-interactive stdin (piped input, CI, or these tests' fake
    // Readable): fall back to an ordinary line-buffered question. There is
    // no keystroke stream to mask in this mode -- the whole line arrives as
    // one chunk -- and masking would only hide a value that's already
    // sitting unmasked in whatever produced the pipe.
    const rl = createInterface({ input: stdin, output: process.stdout });
    return new Promise((resolve, reject) => {
      let settled = false;
      rl.once("close", () => {
        if (settled) return;
        settled = true;
        reject(new Error("Prompt was not answered (stdin closed)."));
      });
      rl.question(promptText, (answer) => {
        settled = true;
        rl.close();
        resolve(answer);
      });
    });
  }

  process.stdout.write(promptText);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    }
    function onData(chunk: string) {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Prompt cancelled (Ctrl-C)."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          // Backspace/delete
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += char;
        process.stdout.write("*");
      }
    }
    stdin.on("data", onData);
  });
}