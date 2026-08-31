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
        throw new Error(`${flag} requires a value.`);
      }
      return value;
    }
  }
  return undefined;
}
