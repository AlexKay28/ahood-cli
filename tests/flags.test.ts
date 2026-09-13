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

  // Deliberately NOT a leftover: a repeated value flag is a separate question
  // (ahood-cli#136), and reporting it here would turn that fix into a
  // behaviour change smuggled in under this one.
  it("strips a repeated value flag and both of its values", () => {
    expect(unrecognizedArgs(["--tags", "a", "--tags", "b"], [], ["--tags"])).toEqual([]);
  });
});
