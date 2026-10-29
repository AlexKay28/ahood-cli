// The one place `ahood setup` / `ahood doctor` touch other programs: finding a
// binary on PATH and running it. Swappable so tests never run the real
// claude/codex/opencode installed on the machine running them.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type RunResult = { status: number | null; stdout: string; stderr: string };

export type Runner = {
  which(bin: string): string | null;
  run(bin: string, args: string[], opts?: { timeoutMs?: number; inherit?: boolean }): RunResult;
};

function whichOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const realRunner: Runner = {
  which: whichOnPath,
  run(bin, args, opts = {}) {
    const result = spawnSync(bin, args, {
      encoding: "utf-8",
      timeout: opts.timeoutMs ?? 15_000,
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
};

/** True when a CLI's `--help` text lists `verb` as a subcommand (`  verb ...` or `  verb|alias ...`). */
export function helpLists(help: string, verb: string): boolean {
  return new RegExp(`^\\s+${verb}(\\|\\S+)?\\s`, "m").test(help);
}

let current: Runner = realRunner;

export function runner(): Runner {
  return current;
}

/** Tests only: swap the runner; returns a restore function. */
export function setRunnerForTests(next: Runner): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}
