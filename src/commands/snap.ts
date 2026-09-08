import { apiJson } from "../http.js";
import { flagValue, parseSearchQuery } from "../flags.js";
import { confirm } from "../confirm.js";
import { UsageError } from "../usage-error.js";

// Mirrors POST/GET /api/v1/snaps' response shapes exactly (see the ahood
// repo's app/api/v1/snaps routes, built concurrently against this frozen
// contract -- see ahood-cli#107). A snap has no owner/slug like a
// skill/agent/mcp artifact -- it's private, session-scoped, and identified
// only by its server-issued id.
type SnapSummary = {
  id: string;
  content_preview: string;
  created_at: string;
  updated_at: string;
  shared: boolean;
};

type SnapDetail = {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  shared: boolean;
  share_url: string | null;
};

const CREATE_USAGE = "Usage: ahood snap create <content> (or pipe content on stdin)";
const LIST_USAGE = "Usage: ahood snap list [--json] [--limit <n>]";
const SEARCH_USAGE = "Usage: ahood snap search <query> [--json] [--limit <n>]";
const SHOW_USAGE = "Usage: ahood snap show <id> [--json]";
const REMOVE_USAGE = "Usage: ahood snap remove <id> [--yes]";
const SHARE_USAGE = "Usage: ahood snap share <id> [--json]";
const UNSHARE_USAGE = "Usage: ahood snap unshare <id> [--yes]";

// There's no existing "read stdin to completion" helper in this codebase to
// reuse -- confirm.ts and secret-prompt.ts both only ever read a single
// line via readline, never an arbitrary-length paste/pipe. Standard Node
// read-to-end pattern: accumulate 'data' chunks until 'end'.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function validateLimit(limitStr: string | undefined, usage: string): void {
  if (limitStr !== undefined && (!/^\d+$/.test(limitStr) || Number(limitStr) < 1)) {
    throw new UsageError(`--limit must be a positive integer (got "${limitStr}").\n${usage}`);
  }
}

// Shared by list/search -- both print the same one-line-per-snap shape and
// the same --json passthrough (the raw `snaps` array, matching
// search.ts/list.ts's convention of emitting just the result array, not the
// whole {snaps, next_cursor} envelope -- neither command exposes cursor-based
// pagination today, only --limit, per ahood-cli#107's spec).
function printSnaps(jsonOutput: boolean, snaps: SnapSummary[], emptyMessage: string): void {
  if (jsonOutput) {
    console.log(JSON.stringify(snaps));
    return;
  }
  if (snaps.length === 0) {
    console.log(emptyMessage);
    return;
  }
  for (const snap of snaps) {
    // content_preview can plausibly contain the note's own internal
    // newlines (it's freeform text) -- collapsed to spaces and re-truncated
    // here so one snap never spills across multiple terminal lines and
    // breaks the "one line per snap" contract.
    const flat = snap.content_preview.replace(/\s+/g, " ").trim();
    const preview = flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
    console.log(`${snap.id} - ${preview} (${snap.created_at})${snap.shared ? " (shared)" : ""}`);
  }
}

export async function createSnap(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  // Joined, not just args[0] -- an unquoted multi-word note (e.g. `ahood
  // snap create Debugged the flaky CI step`) arrives as multiple positional
  // tokens, and taking only the first one silently dropped the rest with no
  // error. Mirrors searchSnaps' own query-joining below.
  const positionals = args.filter((a) => a !== "--json");
  const positional = positionals.length > 0 ? positionals.join(" ") : undefined;

  let content: string;
  if (positional !== undefined) {
    content = positional;
  } else {
    // No positional content -- fall back to stdin (echo "..." | ahood snap
    // create, or a piped heredoc), same convention as e.g. `git commit -F
    // -`. A TTY with nothing piped in would otherwise hang forever waiting
    // for input that will never arrive -- this CLI must never hang
    // indefinitely for unattended/agent use (same reasoning as http.ts's
    // 30s request timeout) -- so that case fails fast with the usage error
    // instead of blocking on readStdin().
    if (process.stdin.isTTY) throw new UsageError(CREATE_USAGE);
    content = await readStdin();
  }

  if (!content.trim()) throw new UsageError(CREATE_USAGE);

  const created = await apiJson<{ id: string; created_at: string }>("/api/v1/snaps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (jsonOutput) {
    console.log(JSON.stringify(created));
    return;
  }
  console.log(created.id);
}

export async function listSnaps(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const limitStr = flagValue(args, "--limit");
  validateLimit(limitStr, LIST_USAGE);

  const qs = new URLSearchParams();
  if (limitStr !== undefined) qs.set("limit", limitStr);
  const query = qs.toString();
  const { snaps } = await apiJson<{ snaps: SnapSummary[] | null; next_cursor: string | null }>(
    `/api/v1/snaps${query ? `?${query}` : ""}`,
  );

  // ?? [], not a bare destructure -- a degraded response (snaps: null)
  // must degrade to "no snaps" instead of crashing, matching list.ts/
  // search.ts's own guard for the identical shape (ahood-cli#106).
  printSnaps(jsonOutput, snaps ?? [], "You have no snaps yet. Run `ahood snap create <content>` to make one.");
}

export async function searchSnaps(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const limitStr = flagValue(args, "--limit");
  const query = parseSearchQuery(args, SEARCH_USAGE);
  validateLimit(limitStr, SEARCH_USAGE);

  const qs = new URLSearchParams({ q: query });
  if (limitStr !== undefined) qs.set("limit", limitStr);
  const { snaps } = await apiJson<{ snaps: SnapSummary[] | null; next_cursor: string | null }>(`/api/v1/snaps?${qs}`);

  // ?? [] -- see listSnaps' identical guard above (ahood-cli#106).
  printSnaps(jsonOutput, snaps ?? [], "No snaps found.");
}

export async function showSnap(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new UsageError(SHOW_USAGE);

  const snap = await apiJson<SnapDetail>(`/api/v1/snaps/${encodeURIComponent(id)}`);

  if (jsonOutput) {
    console.log(JSON.stringify(snap));
    return;
  }

  // Plain mode prints the raw content verbatim -- no formatting/labels/
  // trailing decoration -- mirroring read.ts's own plain-mode contract
  // exactly, process.stdout.write and not console.log: console.log
  // unconditionally appends its own "\n", which double-adds a trailing
  // blank line when the content already ends in one (ahood-cli#108).
  process.stdout.write(snap.content);
}

export async function removeSnap(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new UsageError(REMOVE_USAGE);
  const yes = args.includes("--yes");

  // Matches remove.ts/group.ts's confirm-before-destroy pattern (CLAUDE.md:
  // "Destructive commands ... prompt for confirmation unless --yes is
  // passed") -- deletion is irreversible per the API contract, same class
  // of mistake ahood-cli#98/#99 already fixed for other commands.
  const confirmed = yes ? true : await confirm(`Delete snap ${id}? Type "yes" to confirm: `);
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson<{ deleted: boolean }>(`/api/v1/snaps/${encodeURIComponent(id)}`, { method: "DELETE" });
  console.log(`Deleted snap ${id}.`);
}

export async function shareSnap(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new UsageError(SHARE_USAGE);

  // POST .../share is documented idempotent -- mints a link on first call,
  // returns the same existing one on any later call -- so this never needs
  // a confirm() gate: re-running it can't clobber or duplicate anything.
  const { share_url } = await apiJson<{ share_url: string }>(`/api/v1/snaps/${encodeURIComponent(id)}/share`, {
    method: "POST",
  });

  if (jsonOutput) {
    console.log(JSON.stringify({ share_url }));
    return;
  }
  console.log(share_url);
}

export async function unshareSnap(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new UsageError(UNSHARE_USAGE);
  const yes = args.includes("--yes");

  // Not destructive in the data-loss sense -- the snap itself is untouched,
  // and re-sharing mints/returns a link exactly as before (share is
  // idempotent). But whoever the old link was handed to loses access the
  // instant this runs, with no warning otherwise -- a real effect even
  // though it's recoverable by re-running `share`. Gated the same way as
  // every other snap verb with a live, external side effect (remove,
  // and by analogy group.ts's removeMember/leaveGroup) for consistency
  // across this command group, rather than carving out a silent exception
  // here just because the data itself survives.
  const confirmed = yes ? true : await confirm(`Revoke the share link for snap ${id}? Type "yes" to confirm: `);
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson<{ shared: boolean }>(`/api/v1/snaps/${encodeURIComponent(id)}/share`, { method: "DELETE" });
  console.log(`Unshared snap ${id}.`);
}
