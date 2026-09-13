import { apiJson } from "../http.js";
import { flagValue, parseSearchQuery, unrecognizedArgs, unrecognizedIndices } from "../flags.js";
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

const CREATE_USAGE =
  "Usage: ahood snap create <content> [--tags tag1,tag2] (or pipe content on stdin; put -- before content that starts with --)";
const LIST_USAGE = "Usage: ahood snap list [--json] [--limit <n>] [--tags tag1,tag2]";
const SEARCH_USAGE = "Usage: ahood snap search <query> [--json] [--limit <n>] [--tags tag1,tag2]";
const SHOW_USAGE = "Usage: ahood snap show <id> [--json]";
const REMOVE_USAGE = "Usage: ahood snap remove <id> [--yes]";
const SHARE_USAGE = "Usage: ahood snap share <id> [--json]";
const UNSHARE_USAGE = "Usage: ahood snap unshare <id> [--yes]";
const TAGS_USAGE =
  'Usage: ahood snap tags <id> [tag ...] [--clear] [--json] (with no tag list, prints the snap\'s current tags; pass --clear or "" to remove them all)';

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
  // POSIX end-of-options: everything after a bare "--" is content, verbatim,
  // never a flag. Snap content is freeform, so a note that legitimately begins
  // with "--" would otherwise be unexpressible once the unknown-flag check
  // below lands -- `--tags=value` is exactly that escape hatch for the flag
  // (flags.ts), and content had none (ahood-cli#134).
  //
  // Scoped to `create` rather than made group-wide on purpose: it's the only
  // snap verb whose argument is freeform text. `show`/`remove`/`share`/
  // `unshare` take an id, `tags` a tag list and `search` a query -- all
  // constrained enough that a leading "--" is always a mistake there, so "--"
  // would buy them nothing -- and `search`'s parsing lives in the shared
  // parseSearchQuery, which `skill search` also uses.
  const endOfOptions = args.indexOf("--");
  const flagArgs = endOfOptions === -1 ? args : args.slice(0, endOfOptions);
  const literalArgs = endOfOptions === -1 ? [] : args.slice(endOfOptions + 1);

  const jsonOutput = flagArgs.includes("--json");
  const tagsArg = flagValue(flagArgs, "--tags");

  // Whatever this command doesn't consume. --tags and its value (both
  // "--tags x" and "--tags=x" forms) are stripped the same way --json is, so
  // they never leak into the joined content.
  const leftover = unrecognizedIndices(flagArgs, ["--json"], ["--tags"]);

  // Every leftover used to be kept and folded into the note body, because
  // content is freeform and a blanket "--" rejection would break a note that
  // starts with a dash. That made a typo silently rewrite what got stored, at
  // exit 0: `snap create "my note" --tag deploy` (singular) posted content
  // "my note --tag deploy" with no tags at all, and `--limit 5` likewise
  // (ahood-cli#134). With "--" above providing the escape hatch, refuse them
  // instead -- the same rejection `snap tags` already does below.
  const unknownFlag = leftover.map((i) => flagArgs[i]).find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${CREATE_USAGE}`);

  // The other half of ahood-cli#134, and the part no "--" check catches:
  // `snap create "note" --tags deploy bugfix` posted content "note bugfix",
  // because only the token immediately after --tags is consumed and the second
  // word fell through into the body. A bare token is indistinguishable from a
  // note word on its own -- `--tags deploy Debugged the CI` is a legitimate
  // flags-first invocation -- so the signal isn't the token, it's that content
  // ends up on BOTH sides of a flag. Nobody writes a note with a flag wedged
  // mid-sentence; erroring there refuses the typo without outlawing either
  // ordering. Not silently retagging "bugfix" either: guessing wrong steals a
  // word out of the note, which is the same corruption in the other direction.
  const gap = leftover.findIndex((at, n) => n > 0 && at !== leftover[n - 1] + 1);
  if (gap !== -1) {
    const stray = flagArgs[leftover[gap]];
    const consumed = flagArgs[leftover[gap - 1] + 1];
    throw new UsageError(
      `Note content is split across ${consumed}: "${stray}" comes after it and would be folded into the note. ` +
        `Quote the whole note, or move every flag after it` +
        (consumed === "--tags" ? `; pass multiple tags as one comma-separated value (--tags a,b)` : "") +
        `.\n${CREATE_USAGE}`,
    );
  }

  // Joined, not just args[0] -- an unquoted multi-word note (e.g. `ahood
  // snap create Debugged the flaky CI step`) arrives as multiple positional
  // tokens, and taking only the first one silently dropped the rest with no
  // error. Mirrors searchSnaps' own query-joining below.
  const positionals = [...leftover.map((i) => flagArgs[i]), ...literalArgs];
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
  // Reject whatever this command doesn't accept instead of issuing an
  // unfiltered request and presenting the result as the filtered set:
  // `snap list --tag ci` (singular typo) used to send no tags param at all and
  // print every snap, while the sibling `snap search --tag ci` refused the
  // identical typo -- so a user filtering for "deploy" and seeing three snaps
  // couldn't tell them from the three most recent (ahood-cli#135). That's the
  // same silent-broadening this command's verbatim --tags pass-through below
  // was chosen to avoid; it was defended at the small end and left open at the
  // large one. `snap list` takes no positional argument either, and nothing
  // upstream gives a stray token a meaning (index.ts's dispatchSnap consumes
  // only the verb, and intercepts --help/-h before the handler runs), so an
  // extra positional is a mistake too rather than something to ignore.
  const extra = unrecognizedArgs(args, ["--json"], ["--limit", "--tags"])[0];
  if (extra !== undefined) {
    throw new UsageError(`${extra.startsWith("--") ? "Unknown flag" : "Unexpected argument"}: ${extra}\n${LIST_USAGE}`);
  }
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

// Shared by both of tagsSnap's paths so reading a snap's tags and the echo
// after replacing them print the identical line -- the read is meant to be the
// way a user checks what a write did, which only works if the two agree.
//
// Each tag is printed quoted. Unquoted, `Tags for X: deploy bugfix` is
// character-for-character what ONE tag "deploy bugfix" and TWO tags "deploy"
// and "bugfix" both printed, so a tag list that had silently collapsed into a
// single multi-word tag looked exactly like the correct result and the mistake
// left no trace on screen (ahood-cli#137). JSON.stringify rather than manual
// quoting so a tag that itself contains a quote or a newline stays unambiguous.
function printTags(jsonOutput: boolean, id: string, tags: string[] | null, emptyMessage: string): void {
  // ?? [] -- see printSnaps' identical degrade-on-null guard above
  // (ahood-cli#106): a degraded response shouldn't crash on undefined.length.
  // Normalized before the --json branch too, so the emitted shape is the same
  // {id, tags: []} whether the server said [] or null.
  const list = tags ?? [];
  if (jsonOutput) {
    console.log(JSON.stringify({ id, tags: list }));
    return;
  }
  console.log(list.length > 0 ? `Tags for ${id}: ${list.map((t) => JSON.stringify(t)).join(", ")}` : emptyMessage);
}

export async function tagsSnap(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const clear = args.includes("--clear");
  // Folded onto flags.ts's shared stripping helper, which this command was the
  // last caller still hand-rolling its own copy of (see unrecognizedArgs'
  // comment, ahood-cli#135/#136). The `args.filter(a => a !== "--json")` it
  // replaces knew about exactly one flag, so --clear below would have meant
  // growing a third variant of the same rules -- the duplication that let
  // `snap list` ship with no unknown-flag check at all.
  const positionals = unrecognizedArgs(args, ["--json", "--clear"], []);
  // Reject stray "--" flags rather than folding them into the tag list
  // (parseSearchQuery in flags.ts does the same). Without this, the natural
  // mistake `snap tags <id> --tags a,b` -- natural because `snap create`
  // really does spell it `--tags a,b` -- silently PATCHed the tag set to
  // ["--tags a", "b"], and `snap tags --yes <id>` used "--yes" as the id.
  const unknownFlag = positionals.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${TAGS_USAGE}`);
  const id = positionals[0];
  if (!id) throw new UsageError(TAGS_USAGE);

  const tagArgs = positionals.slice(1);
  if (clear && tagArgs.length > 0) {
    throw new UsageError(
      `--clear takes no tag list, but got "${tagArgs[0]}". Pass --clear to remove every tag, or the tags to set -- not both.\n${TAGS_USAGE}`,
    );
  }

  // The bare `snap tags <id>` form READS instead of clearing (ahood-cli#138).
  // It used to PATCH {"tags":[]} unconfirmed, and it is the form a user reaches
  // for to ASK what a snap's tags are -- `git tag`, `docker tag` and `hg tags`
  // all read on their bare form, and nothing else in this CLI showed one snap's
  // tags (`snap show` prints content only, `snap list` truncates across all
  // snaps), so the answer was destroyed by the act of asking. Destroying a tag
  // set now takes saying so: --clear, or the documented explicit "" form below.
  // That's why there's still no confirm() gate here, unlike remove/unshare --
  // the accident it would have guarded against can no longer be typed by
  // accident, and #114's original reasoning (metadata only, and re-running
  // `tags` with the old set restores it exactly) holds once the user can
  // actually find out what the old set was.
  if (!clear && tagArgs.length === 0) {
    const snap = await apiJson<SnapDetail>(`/api/v1/snaps/${encodeURIComponent(id)}`);
    printTags(jsonOutput, snap.id, snap.tags, `${snap.id} has no tags.`);
    return;
  }

  // Each positional is parsed on its own, then concatenated -- NOT joined into
  // one string first. The join existed to rescue an unquoted `tags <id>
  // "deploy, bugfix"`, which the shell hands over as two argv entries and which
  // taking only positionals[1] silently truncated (ahood-cli#114). But joining
  // cannot tell that apart from a user typing space separators, so `tags <id>
  // deploy bugfix` became the single tag "deploy bugfix" (ahood-cli#137).
  // Splitting per token serves both: ["deploy,", "bugfix"] and ["deploy",
  // "bugfix"] each yield ["deploy", "bugfix"], while a tag that genuinely
  // contains a space stays expressible by quoting it as one argument -- which
  // treating whitespace as a separator would have taken away.
  const tags = tagArgs.flatMap((arg) =>
    arg
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );

  // PATCH replaces the full tag set (not a merge) -- passing --clear, or an
  // empty string, sends [] and clears every tag, matching the "pass [] to
  // clear" contract of the endpoint itself.
  const updated = await apiJson<{ id: string; tags: string[] | null }>(`/api/v1/snaps/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });

  printTags(jsonOutput, updated.id, updated.tags, `Cleared tags for ${updated.id}.`);
}
