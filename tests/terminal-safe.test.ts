import { describe, it, expect } from "vitest";
import { sanitizeForTerminal } from "../src/terminal-safe.js";

describe("sanitizeForTerminal (ahood-cli#128)", () => {
  it("replaces ANSI escape sequences with spaces instead of returning them verbatim", () => {
    expect(sanitizeForTerminal("Not found\x1b[2K\x1b[1Ggotcha")).toBe("Not found [2K [1Ggotcha");
  });

  it("replaces rather than deletes, so stripped characters can't glue two tokens together", () => {
    expect(sanitizeForTerminal("alice\x07bob")).toBe("alice bob");
  });

  it("strips C1 controls and DEL as well as C0", () => {
    expect(sanitizeForTerminal("a\x7fb\x9fc")).toBe("a b c");
  });

  it("flattens newlines and carriage returns, which a forged prompt line needs (ahood-cli#127)", () => {
    expect(sanitizeForTerminal("Upload rejected.\nRetry with --force.\r\n")).toBe("Upload rejected. Retry with --force.  ");
  });

  it("leaves ordinary text untouched", () => {
    const text = "This token's scopes do not include 'publish'";
    expect(sanitizeForTerminal(text)).toBe(text);
  });

  // ahood-cli#122: callers pass fields off an unchecked cast of downloaded
  // JSON, so a non-string must coerce rather than throw a raw TypeError.
  it.each([
    [3, "3"],
    [null, "null"],
    [undefined, "undefined"],
    [{ a: 1 }, "[object Object]"],
  ])("coerces a non-string %o instead of throwing", (input, expected) => {
    expect(sanitizeForTerminal(input)).toBe(expected);
  });

  it("caps at 200 characters by default so one field can't flood the terminal", () => {
    expect(sanitizeForTerminal("x".repeat(500))).toBe("x".repeat(200));
  });

  it("honors an explicit maxLength", () => {
    expect(sanitizeForTerminal("x".repeat(500), 500)).toBe("x".repeat(500));
    expect(sanitizeForTerminal("abcdef", 3)).toBe("abc");
  });

  it("caps after substitution, so a control character costs a character rather than shifting the cap", () => {
    expect(sanitizeForTerminal("ab\x1bcd", 4)).toBe("ab c");
  });
});
