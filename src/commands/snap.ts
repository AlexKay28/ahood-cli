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
  tags: string[];
};

type SnapDetail = {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
  shared: boolean;
  share_url: string | null;
  tags: string[];
};

const CREATE_USAGE = "Usage: ahood snap create <content> [--tags tag1,tag2] (or pipe content on stdin)";
const LIST_USAGE = "Usage: ahood snap list [--json] [--limit <n>] [--tags tag1,tag2]";
const SEARCH_USAGE = "Usage: ahood snap search <query> [--json] [--limit <n>] [--tags tag1,tag2]";
const SHOW_USAGE = "Usage: ahood snap show <id> [--json]";
const REMOVE_USAGE = "Usage: ahood snap remove <id> [--yes]";
const SHARE_USAGE = "Usage: ahood snap share <id> [--json]";
const UNSHARE_USAGE = "Usage: ahood snap unshare <id> [--yes]";
const TAGS_USAGE = "Usage: ahood snap tags <id> [tag1,tag2,...] [--json] (omit or pass an empty value to clear all tags)";

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
    // ?? [] -- see listSnaps/searchSnaps' identical degrade-on-null guard
    // below; a snap predating the tags column, or a degraded response,
    // should just show no tags rather than crashing on undefined.length.
    const tags = snap.tags ?? [];
    const tagsSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    console.log(`${snap.id} - ${preview} (${snap.created_at})${snap.shared ? " (shared)" : ""}${tagsSuffix}`);
  }
}

export async function createSnap(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const tagsArg = flagValue(args, "--tags");
  // Joined, not just args[0] -- an unquoted multi-word note (e.g. `ahood
  // snap create Debugged the flaky CI step`) arrives as multiple positional
  // tokens, and taking only the first one silently dropped the rest with no
  // error. Mirrors searchSnaps' own query-joining below. --tags and its
  // value (both "--tags x" and "--tags=x" forms) are stripped the same way
  // --json is, so they never leak into the joined content.
  const positionals = args.filter(
    (a, i) => a !== "--json" && a !== "--tags" && !a.startsWith("--tags=") && args[i - 1] !== "--tags",
  );
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

  // Same comma-split convention as `ahood skill publish --tags`/`edit
  // --tags`. Omitted entirely when --tags wasn't passed at all, so the
  // request body matches the "omitting tags is equivalent to []" contract
  // exactly instead of always sending an (empty) tags array.
  const body: { content: string; tags?: string[] } = { content };
  if (tagsArg !== undefined) {
    body.tags = tagsArg
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const created = await apiJson<{ id: string; created_at: string }>("/api/v1/snaps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  const tagsStr = flagValue(args, "--tags");
  validateLimit(limitStr, LIST_USAGE);

  const qs = new URLSearchParams();
  if (limitStr !== undefined) qs.set("limit", limitStr);
  // Passed through verbatim rather than split/trimmed the way createSnap's
  // own --tags is: the server owns what a tag filter means (comma-separated,
  // ANDed, case-insensitive, 400 past 8 terms) and deliberately keeps an
  // unstorable term instead of dropping it, since dropping one would silently
  // broaden the result set. Re-parsing here would be a second implementation
  // of that contract, free to drift from it (ahood-cli#118).
  if (tagsStr !== undefined) qs.set("tags", tagsStr);
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
  const tagsStr = flagValue(args, "--tags");
  // --tags declared here so its VALUE isn't swallowed into the joined query
  // string -- `snap search deploy --tags ci` must search for "deploy" filtered
  // to tag "ci", not for "deploy ci" (ahood-cli#118).
  const query = parseSearchQuery(args, SEARCH_USAGE, ["--tags"]);
  validateLimit(limitStr, SEARCH_USAGE);

  const qs = new URLSearchParams({ q: query });
  if (limitStr !== undefined) qs.set("limit", limitStr);
  // Verbatim -- see listSnaps' identical pass-through above (ahood-cli#118).
  // The server ANDs a tag filter with `q`, so this narrows the text results.
  if (tagsStr !== undefined) qs.set("tags", tagsStr);
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

export async function tagsSnap(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const positionals = args.filter((a) => a !== "--json");
  // Reject stray "--" flags rather than folding them into the tag list
  // (parseSearchQuery in flags.ts does the same). Without this, the natural
  // mistake `snap tags <id> --tags a,b` -- natural because `snap create`
  // really does spell it `--tags a,b` -- silently PATCHed the tag set to
  // ["--tags a", "b"], and `snap tags --yes <id>` used "--yes" as the id.
  const unknownFlag = positionals.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${TAGS_USAGE}`);
  const id = positionals[0];
  if (!id) throw new UsageError(TAGS_USAGE);

  // PATCH replaces the full tag set (not a merge) -- omitting the tags
  // argument, or passing an empty string, both clear every tag, matching
  // the "pass [] to clear" contract of the endpoint itself. Joined, not
  // just positionals[1] -- an unquoted "tag1, tag2" arrives as multiple
  // positional tokens, and taking only the first one silently dropped the
  // rest with no error, the same bug createSnap's own content-joining
  // above already fixed.
  const tagsArg = positionals.slice(1).join(" ");
  const tags = tagsArg
    ? tagsArg
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  // No confirm() gate, unlike remove/unshare -- this only replaces metadata
  // (tags), never the snap's content or its shareability, and re-running
  // `tags` with the old set restores it exactly. Per ahood-cli#114's spec.
  const updated = await apiJson<{ id: string; tags: string[] | null }>(`/api/v1/snaps/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });

  if (jsonOutput) {
    console.log(JSON.stringify(updated));
    return;
  }
  // ?? [] -- see printSnaps' identical degrade-on-null guard above
  // (ahood-cli#106): a degraded response shouldn't crash on undefined.length.
  const updatedTags = updated.tags ?? [];
  console.log(
    updatedTags.length > 0 ? `Tags for ${updated.id}: ${updatedTags.join(", ")}` : `Cleared tags for ${updated.id}.`,
  );
}
