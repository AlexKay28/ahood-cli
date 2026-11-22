import { ApiError, apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";
import { flagValue, unrecognizedArgs } from "../flags.js";
import { ensureRemoteKind, strictKind, type KindScope } from "../kinds.js";

type VoteResponse = { value: "up" | "down" | 1 | -1 | null; upvotes: number; downvotes: number };

const NOTE_MAX = 500;

function usageFor(scope: KindScope | undefined): string {
  const noun = scope?.noun ?? "skill";
  return `Usage: ahood ${noun} vote <owner>/<slug> up|down [--note <text>] [--version <x.y.z>] [--json]\n       ahood ${noun} vote <owner>/<slug> --clear [--json]`;
}

function tally(r: VoteResponse): string {
  return `(▲${r.upvotes} ▼${r.downvotes})`;
}

// POST/DELETE /api/v1/skills/{owner}/{skill}/vote. A vote is one live row per
// account: voting again flips or replaces it, --clear deletes it. The server
// gates voting on use (a download, a read or a star) and refuses your own
// artifacts; both come back as 403 with a `code`, which is turned into advice
// here rather than shown as the bare server sentence.
export async function vote(args: string[], scope?: KindScope): Promise<void> {
  const USAGE = usageFor(scope);
  const noun = scope?.noun ?? "skill";
  const jsonOutput = args.includes("--json");
  const clear = args.includes("--clear");
  const note = flagValue(args, "--note");
  const version = flagValue(args, "--version");
  const leftovers = unrecognizedArgs(args, ["--json", "--clear"], ["--note", "--version"]);
  const unknownFlag = leftovers.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new UsageError(`Unknown argument: ${unknownFlag}\n${USAGE}`);

  const spec = leftovers[0];
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  const direction = leftovers[1];
  if (leftovers.length > 2) throw new UsageError(`Unexpected extra argument: ${leftovers[2]}\n${USAGE}`);

  if (clear) {
    if (direction !== undefined) throw new UsageError(`--clear takes no up|down.\n${USAGE}`);
    if (note !== undefined || version !== undefined) throw new UsageError(`--clear cannot be combined with --note or --version.\n${USAGE}`);
  } else {
    if (direction !== "up" && direction !== "down") throw new UsageError(USAGE);
    if (note !== undefined && note.length > NOTE_MAX) {
      throw new UsageError(`--note is ${note.length} characters; the limit is ${NOTE_MAX}.`);
    }
  }

  await ensureRemoteKind(scope, owner, skill, "vote", "vote on");
  const path = `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/vote`;
  const key = `${owner}/${skill}`;

  let result: VoteResponse;
  try {
    result = clear
      ? await apiJson<VoteResponse>(path, { method: "DELETE" })
      : await apiJson<VoteResponse>(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: direction,
            ...(version !== undefined ? { version } : {}),
            ...(note !== undefined ? { note } : {}),
          }),
        });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      const code = (error.body as { code?: unknown } | undefined)?.code;
      if (code === "vote_requires_use") {
        const kind = strictKind(scope);
        const installHint = kind === "prompt" ? "" : `install it (\`ahood ${noun} add ${key}\`) or `;
        throw new ApiError(
          403,
          `You can only vote on something you have used. First ${installHint}read it (\`ahood ${noun} read ${key}\`), then vote.`,
          error.body,
        );
      }
      if (code === "cannot_vote_own") {
        throw new ApiError(403, `${key} is yours -- you cannot vote on your own artifact.`, error.body);
      }
    }
    throw error;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result));
    return;
  }
  if (clear) {
    console.log(`Cleared your vote on ${key}.`);
    return;
  }
  console.log(`${direction === "up" ? "Upvoted" : "Downvoted"} ${key} ${tally(result)}.`);
}
