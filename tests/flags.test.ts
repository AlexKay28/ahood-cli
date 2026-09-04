import { describe, expect, it } from "vitest";
import { flagValue } from "../src/flags.js";
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
