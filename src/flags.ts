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
export function flagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === flag) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${flag} requires a value.`);
      }
      return value;
    }
  }
  return undefined;
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
// filtered set (ahood-cli#135). parseSearchQuery below and tagsSnap still carry
// their own inline copies of this stripping; fold them into this helper when
// the queued snap-parsing fixes (ahood-cli#136/#137/#138) next touch them,
// rather than growing a fourth variant.
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (booleanFlags.includes(arg)) continue;
    if (valueFlags.includes(arg)) continue;
    if (valueFlags.some((f) => arg.startsWith(`${f}=`))) continue;
    if (valueFlags.includes(args[i - 1])) continue;
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
  const stripped = ["--limit", ...valueFlags];
  const queryParts = args.filter(
    (a, i) =>
      a !== "--json" &&
      !stripped.includes(a) &&
      !stripped.some((f) => a.startsWith(`${f}=`)) &&
      !stripped.includes(args[i - 1]),
  );
  const unknownFlag = queryParts.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${usage}`);
  const query = queryParts.join(" ");
  if (!query) throw new UsageError(usage);
  return query;
}
