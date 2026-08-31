import { createInterface } from "node:readline";
import { apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";

const USAGE = "Usage: ahood unpublish <owner>/<skill> [--yes]";

// On closed/non-interactive stdin, readline/promises' rl.question() promise
// never settles -- but since nothing else keeps the event loop alive at that
// point, the process used to exit 0 anyway once the loop drained, having
// printed only the prompt (no "Aborted.", no deletion, no error: a silent
// false success). The plain callback-style API is used instead specifically
// so the "close" listener can be a reliable signal for "closed without ever
// answering": `settled` is set synchronously inside the answer callback,
// before rl.close() is called, so that same close doesn't self-reject.
function confirm(promptText: string): Promise<boolean> {
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

export async function unpublish(args: string[]): Promise<void> {
  const yes = args.includes("--yes");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new Error(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  const key = `${owner}/${skill}`;

  // --yes bypasses the prompt for scripts/CI; otherwise a closed stdin (no
  // TTY, no piped answer either) now throws via confirm()'s "close" handling
  // instead of silently exiting 0 with nothing prompted, confirmed, or done.
  const confirmed = yes
    ? true
    : await confirm(`This will permanently delete ${key} for everyone who has installed it. Type "yes" to confirm: `);

  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`, { method: "DELETE" });
  console.log(`Unpublished ${key}. Run \`ahood remove ${key}\` to also remove your local copy.`);
}
