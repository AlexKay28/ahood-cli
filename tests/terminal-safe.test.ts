import { describe, it, expect } from "vitest";
import { sanitizeDocumentForTerminal, sanitizeForTerminal } from "../src/terminal-safe.js";

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

describe("sanitizeDocumentForTerminal (ahood-cli#133)", () => {
  it("replaces the same C0/C1 controls sanitizeForTerminal does", () => {
    expect(sanitizeDocumentForTerminal("a\x1b]52;c;AAAA\x07b")).toBe("a ]52;c;AAAA b");
    expect(sanitizeDocumentForTerminal("a\x7fb\x9fc")).toBe("a b c");
  });

  it("replaces rather than deletes, for the same anti-token-gluing reason", () => {
    expect(sanitizeDocumentForTerminal("alice\x07bob")).toBe("alice bob");
  });

  it("preserves the layout characters a document is made of: \\n, \\r and \\t", () => {
    expect(sanitizeDocumentForTerminal("# Title\r\n\n- one\n-\ttwo\n")).toBe("# Title\r\n\n- one\n-\ttwo\n");
  });

  it("does not truncate, however long the document is", () => {
    const long = "x".repeat(100_000);
    expect(sanitizeDocumentForTerminal(long)).toBe(long);
  });

  it("leaves ordinary prose untouched", () => {
    const text = "# Demo Skill\n\nDo the thing.\n";
    expect(sanitizeDocumentForTerminal(text)).toBe(text);
  });

  // ahood-cli#122, same rationale as sanitizeForTerminal's: callers pass
  // fields off an unchecked cast of downloaded JSON.
  it.each([
    [3, "3"],
    [null, "null"],
    [undefined, "undefined"],
  ])("coerces a non-string %o instead of throwing", (input, expected) => {
    expect(sanitizeDocumentForTerminal(input)).toBe(expected);
  });
});
