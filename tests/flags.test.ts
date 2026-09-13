import { describe, expect, it } from "vitest";
import { flagValue, unrecognizedArgs } from "../src/flags.js";
import { UsageError } from "../src/usage-error.js";

describe("flagValue", () => {
  it("accepts a --flag=value token even when the value starts with --", () => {
    expect(flagValue(["--tagline=--fast and cheap"], "--tagline")).toBe("--fast and cheap");
  });

  // Distinguished from a plain Error so exit-code.ts maps it to exit code 2,
  // not the generic 1 (ahood-cli#80).
  it("throws a UsageError specifically, not a plain Error", () => {
    expect(() => flagValue(["--tagline"], "--tagline")).toThrow(UsageError);
  });

  it("still supports the space-separated --flag value form", () => {
    expect(flagValue(["--tagline", "fast and cheap"], "--tagline")).toBe("fast and cheap");
  });

  it("throws when a space-separated flag is immediately followed by another flag", () => {
    expect(() => flagValue(["--tagline", "--other-flag"], "--tagline")).toThrow(/--tagline requires a value/);
  });

  it("throws when a space-separated flag has no following token at all", () => {
    expect(() => flagValue(["--tagline"], "--tagline")).toThrow(/--tagline requires a value/);
  });

  it("returns undefined when the flag isn't present", () => {
    expect(flagValue(["--other", "x"], "--tagline")).toBeUndefined();
  });

  it("preserves a literal = inside the value for the --flag=value form", () => {
    expect(flagValue(["--tagline=a=b"], "--tagline")).toBe("a=b");
  });

  // ahood-cli#136: first-wins silently discarded the second value (and the
  // stripping below silently ate its neighbour). Refused outright instead --
  // neither value is guessed at.
  it("throws on a repeated flag rather than returning the first value", () => {
    expect(() => flagValue(["--tags", "a", "--tags", "bar"], "--tags")).toThrow(/--tags given more than once/);
  });

  it("throws on a repeat across the two spellings, in either order", () => {
    expect(() => flagValue(["--tags", "a", "--tags=b"], "--tags")).toThrow(/--tags given more than once/);
    expect(() => flagValue(["--tags=a", "--tags", "b"], "--tags")).toThrow(/--tags given more than once/);
    expect(() => flagValue(["--tags=a", "--tags=b"], "--tags")).toThrow(/--tags given more than once/);
  });

  it("throws a UsageError for a repeat, so exit-code.ts maps it to 2", () => {
    expect(() => flagValue(["--limit", "1", "--limit", "2"], "--limit")).toThrow(UsageError);
  });

  // "--tags accumulates" is the misconception that produces the repeat, so the
  // message says how to actually pass several tags.
  it("points a repeated --tags at the comma-separated spelling", () => {
    expect(() => flagValue(["--tags", "a", "--tags", "b"], "--tags")).toThrow(/comma-separated value \(--tags a,b\)/);
  });

  it("does not mistake a repeat of a DIFFERENT flag for a repeat of this one", () => {
    expect(flagValue(["--tags", "a", "--limit", "1", "--limit", "2"], "--tags")).toBe("a");
  });
});

// ahood-cli#135 -- the check `snap list` was missing entirely.
describe("unrecognizedArgs", () => {
  it("strips declared boolean flags and value flags in both spellings", () => {
    expect(unrecognizedArgs(["--json", "--limit", "5", "--tags=a,b"], ["--json"], ["--limit", "--tags"])).toEqual([]);
  });

  it("returns an unrecognized flag", () => {
    expect(unrecognizedArgs(["--tag", "ci"], ["--json"], ["--limit", "--tags"])).toEqual(["--tag", "ci"]);
  });

  it("returns a stray positional", () => {
    expect(unrecognizedArgs(["garbage"], ["--json"], ["--limit", "--tags"])).toEqual(["garbage"]);
  });

  // A value flag consumes only the token that follows it, so the token after
  // the --flag=value form is still a leftover.
  it("does not swallow the token after a --flag=value token", () => {
    expect(unrecognizedArgs(["--limit=5", "garbage"], ["--json"], ["--limit"])).toEqual(["garbage"]);
  });

  // Was pinned as "strips a repeated value flag and both of its values" while
  // ahood-cli#136 was still undecided. Decided: refused, with the same message
  // flagValue gives, so whichever of the two a command reaches first says the
  // same thing -- reporting the second --tags as "Unknown flag" instead would
  // be a confusing way to describe a duplicate.
  it("throws on a repeated value flag instead of stripping both of its values", () => {
    expect(() => unrecognizedArgs(["--tags", "a", "--tags", "b"], [], ["--tags"])).toThrow(
      /--tags given more than once/,
    );
    expect(() => unrecognizedArgs(["--tags", "a", "--tags=b"], [], ["--tags"])).toThrow(UsageError);
  });

  // The half of #136 that deleted a word: only the occurrence that actually
  // consumed a value may strip one, so a bare token after a DIFFERENT flag's
  // value is still a leftover (for snap search, still part of the query).
  it("strips only the value the flag itself consumed, not every neighbour", () => {
    expect(unrecognizedArgs(["foo", "--limit", "5", "bar"], ["--json"], ["--limit"])).toEqual(["foo", "bar"]);
  });

  // Mirrors flagValue's swallow-protection: a "--" token is never a value, so
  // it is judged on its own instead of vanishing as --limit's neighbour.
  it("does not consume a following flag as a value", () => {
    expect(unrecognizedArgs(["--limit", "--bogus"], ["--json"], ["--limit"])).toEqual(["--bogus"]);
  });
});
