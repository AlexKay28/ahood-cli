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
