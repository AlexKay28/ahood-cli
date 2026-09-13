import { UsageError } from "./usage-error.js";

// Shared flag-value parsing. Throws instead of silently treating the next flag
// as this flag's value (e.g. `--tagline --visibility public` used to send
// "--visibility" as the tagline and drop --visibility entirely).
//
// Two forms are accepted:
//   --flag value    Space-separated. If `value` itself looks like a flag
//                    (starts with "--"), that's treated as "no value given"
//                    per the swallow-protection above, and this throws.
//   --flag=value     Explicit-equals. Everything after the first "=" is the
//                    value, verbatim, even if it starts with "--" -- this is
//                    the unambiguous escape hatch for values that genuinely
//                    start with "--" (e.g. a tagline like "--fast and cheap").
// A repeated value flag is refused rather than resolved. `flagValue` used to
// return the FIRST match and stop, while the stripping below skipped EVERY
// occurrence's neighbour, so `snap search foo --tags a --tags bar` searched for
// "foo" tagged "a" and deleted "bar" from the query outright -- the user got
// results for a command they did not type, at exit 0 (ahood-cli#136). Both
// last-wins and first-wins are silent guesses about which fragment of a
// command reassembled from shell history is the stale one; the CLI already
// refuses flags it doesn't recognize, and refusing here is the only option that
// cannot discard a value the user typed. The cost is one retry with the
// duplicate deleted, which is also the edit the user has to make anyway.
function assertFirstOccurrence(seen: Set<string>, flag: string): void {
  if (seen.has(flag)) {
    throw new UsageError(
      `${flag} given more than once. Pass it once -- repeating it would silently discard one of the values` +
        // Safe to say unconditionally for --tags: every --tags in this CLI
        // (publish/edit/snap create/list/search) is one comma-separated value,
        // and "it accumulates" is the misconception that produces the repeat.
        (flag === "--tags" ? `; pass multiple tags as one comma-separated value (--tags a,b)` : "") +
        `.`,
    );
  }
  seen.add(flag);
}

export function flagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const seen = new Set<string>();
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(prefix)) {
      assertFirstOccurrence(seen, flag);
      found = arg.slice(prefix.length);
      continue;
    }
    if (arg === flag) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${flag} requires a value.`);
      }
      assertFirstOccurrence(seen, flag);
      found = value;
    }
  }
  return found;
}

// Returns the tokens left over after stripping the flags a command declares:
// `booleanFlags` stand alone (--json), `valueFlags` consume the following token
// and also accept the --flag=value form. Whatever remains is something the
// command does NOT accept -- an unrecognized "--" flag or a stray positional --
// and it's the caller's job to reject it (or, for a query/id command, to
// interpret it as the positional).
//
// Lives here rather than inline in each command because hand-rolling this check
// per command is exactly how `snap list` ended up with no check at all while
// its sibling `snap search` had one, so `snap list --tag ci` (singular typo)
// issued an UNFILTERED request and printed every snap as though it were the
// filtered set (ahood-cli#135). parseSearchQuery below is now a caller of this
// helper rather than a second copy of it (folded in by ahood-cli#136, whose bug
// existed in both copies); tagsSnap still carries its own inline copy -- fold it
// in when the queued snap-parsing fixes (ahood-cli#137/#138) next touch it,
// rather than growing a third variant again.
export function unrecognizedArgs(args: string[], booleanFlags: string[], valueFlags: string[]): string[] {
  return unrecognizedIndices(args, booleanFlags, valueFlags).map((i) => args[i]);
}

// The same stripping rules as unrecognizedArgs, reporting WHERE the leftovers
// sat rather than what they were -- and the primitive the two share, so there
// is still exactly one copy of those rules (the whole point of #135's helper;
// a second hand-rolled variant is the mistake it exists to stop).
//
// `snap create` needs the positions, not just the tokens: its leftovers are the
// words of a freeform note, so "starts with --" is the only thing it can reject
// outright, and the one remaining signal that a bare token was misplaced is that
// the leftovers sit on BOTH sides of a flag the command consumed -- which is
// precisely `snap create "note" --tags deploy bugfix` folding "bugfix" into the
// note body (ahood-cli#134). Positions are the only way to see that gap.
export function unrecognizedIndices(args: string[], booleanFlags: string[], valueFlags: string[]): number[] {
  const indices: number[] = [];
  const seen = new Set<string>();
  // Which index (if any) the value flag just seen actually consumed. The test
  // used to be `valueFlags.includes(args[i - 1])`, which stripped the neighbour
  // of EVERY occurrence -- so a repeated --tags ate a word nothing had read
  // (ahood-cli#136). Tracking the consuming occurrence means exactly one token
  // per accepted flag disappears, and assertFirstOccurrence refuses the repeat
  // with the same message flagValue gives, so a caller that reaches this helper
  // first can't report the duplicate as "Unknown flag: --tags" instead.
  let consumedAt = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (i === consumedAt) continue;
    if (booleanFlags.includes(arg)) continue;
    if (valueFlags.includes(arg)) {
      assertFirstOccurrence(seen, arg);
      // Same swallow-protection as flagValue: a following "--" token is not
      // this flag's value, it's the next flag, so leave it to be judged on its
      // own (flagValue throws "requires a value" for it first in every caller).
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) consumedAt = i + 1;
      continue;
    }
    const equalsForm = valueFlags.find((f) => arg.startsWith(`${f}=`));
    if (equalsForm !== undefined) {
      assertFirstOccurrence(seen, equalsForm);
      continue;
    }
    indices.push(i);
  }
  return indices;
}

// Shared by every "<verb> <query> [--json] [--limit <n>]" command (skill
// search, snap search) -- factored out after this exact logic was
// duplicated verbatim between them, which is exactly how ahood-cli#105's
// "--limit=5 misparsed as an unknown flag" bug could have silently come
// back in one copy while being fixed in the other. Strips --json and
// --limit (both "--limit N" and "--limit=N" forms) from the positional
// args, rejects any other unrecognized "--" flag, and joins what's left
// into a single query string.
// `valueFlags` names ADDITIONAL "--flag value" flags this particular command
// accepts (snap search's --tags, ahood-cli#118), on top of --limit, which
// every caller takes. Passed per-caller rather than stripping a shared union
// of every search-ish flag, so `ahood skill search --tags x` still errors on
// a flag that command doesn't implement instead of silently ignoring it and
// returning unfiltered results.
export function parseSearchQuery(args: string[], usage: string, valueFlags: string[] = []): string {
  // Delegated to unrecognizedArgs rather than re-filtering here: this was the
  // second hand-rolled copy of those stripping rules, and it carried the same
  // repeated-flag bug (ahood-cli#136) that the first one did -- which is the
  // duplication hazard #135's helper was extracted to end.
  const queryParts = unrecognizedArgs(args, ["--json"], ["--limit", ...valueFlags]);
  const unknownFlag = queryParts.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${usage}`);
  const query = queryParts.join(" ");
  if (!query) throw new UsageError(usage);
  return query;
}
