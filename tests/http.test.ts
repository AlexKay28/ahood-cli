import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { apiFetch, apiJson, ApiError, NetworkError, sanitizeErrorMessage } from "../src/http.js";

const API_URL = "http://ahood.test";

// vitest's restoreMocks/clearMocks (ahood-cli#124) don't cover stubGlobal or the
// env var, so both describes below need this same harness -- shared rather than
// copied so the two can't drift apart.
function useStubbedApi(): void {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });
}

describe("apiJson error sanitization", () => {
  useStubbedApi();

  it("passes short, normal server error messages through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "This token's scopes do not include 'publish'" }), { status: 403 })),
    );
    await expect(apiJson("/x")).rejects.toThrow("This token's scopes do not include 'publish'");
  });

  it("replaces an HTML-shaped error body (e.g. a WAF/proxy block page) with a short, safe summary (ahood-cli#31)", async () => {
    const html = "<!DOCTYPE html>\n<html><head><title>Attention Required! | Cloudflare</title></head><body>Ray ID: abc123, Your IP: 1.2.3.4</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: html }), { status: 500 })));

    let caught: unknown;
    try {
      await apiJson("/x");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const message = (caught as ApiError).message;
    expect(message).not.toContain("<html");
    expect(message).not.toContain("Cloudflare");
    expect(message).not.toContain("Ray ID");
    expect(message.length).toBeLessThan(300);
  });

  it("replaces an implausibly long error message even without HTML markers", async () => {
    const huge = "x".repeat(2000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: huge }), { status: 500 })));

    let caught: unknown;
    try {
      await apiJson("/x");
    } catch (e) {
      caught = e;
    }
    expect((caught as ApiError).message.length).toBeLessThan(300);
  });

  it("resolves with undefined instead of throwing on a 204 No Content success response (#103)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    await expect(apiJson("/x")).resolves.toBeUndefined();
  });

  it("resolves with undefined for any 2xx with an empty body, not just 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    await expect(apiJson("/x")).resolves.toBeUndefined();
  });

  it("still throws a 'Malformed response' error for a non-empty, non-JSON success body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));

    await expect(apiJson("/x")).rejects.toThrow(/Malformed response/);
  });

  it("neutralizes ANSI escapes in a short error body before it reaches the terminal (ahood-cli#127)", async () => {
    const escapes = "Not found\x1b[2K\x1b[1GEnter your token:";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: escapes }), { status: 404 })));

    let caught: unknown;
    try {
      await apiJson("/x");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});

describe("sanitizeErrorMessage control characters (ahood-cli#127)", () => {
  it("replaces ANSI escape sequences with spaces instead of returning them verbatim", () => {
    expect(sanitizeErrorMessage("Not found\x1b[2K\x1b[1Ggotcha")).toBe("Not found [2K [1Ggotcha");
  });

  it("replaces rather than deletes, so stripped characters can't glue two tokens together", () => {
    expect(sanitizeErrorMessage("alice\x07bob")).toBe("alice bob");
  });

  it("strips C1 controls and DEL as well as C0", () => {
    expect(sanitizeErrorMessage("a\x7fb\x9fc")).toBe("a b c");
  });

  it("flattens newlines and carriage returns, which a forged prompt line needs (see comment at the fix)", () => {
    expect(sanitizeErrorMessage("Upload rejected.\nRetry with --force.\r\n")).toBe("Upload rejected. Retry with --force.  ");
  });

  it("leaves an ordinary short message untouched", () => {
    const message = "This token's scopes do not include 'publish'";
    expect(sanitizeErrorMessage(message)).toBe(message);
  });

  it("still replaces an HTML-shaped body with the generic summary, escapes or not", () => {
    const html = "<!DOCTYPE html>\x1b[2K<html><head><title>Cloudflare</title></head></html>";
    const result = sanitizeErrorMessage(html);
    expect(result).toMatch(/^Request failed with an unexpected, oversized, or HTML-shaped error response/);
    expect(result).not.toContain("Cloudflare");
  });

  it("still replaces an oversized body with the generic summary, escapes or not", () => {
    const huge = "\x1b[2K" + "x".repeat(2000);
    const result = sanitizeErrorMessage(huge);
    expect(result).toMatch(/^Request failed with an unexpected, oversized, or HTML-shaped error response/);
    expect(result).toContain(`(${huge.length} bytes)`);
  });
});

describe("NetworkError message sanitization (ahood-cli#129)", () => {
  useStubbedApi();

  async function networkErrorFrom(rejection: unknown): Promise<NetworkError> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw rejection;
      }),
    );
    const caught: unknown = await apiFetch("/x").catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(NetworkError);
    return caught as NetworkError;
  }

  // The point of this message is diagnosing a broken network, so the bar isn't
  // "contains no escapes" -- it's that verbatim.
  it("still names the host and the underlying reason readably", async () => {
    const error = await networkErrorFrom(new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:3000") }));
    expect(error.message).toBe("Request to http://ahood.test/x failed (fetch failed: connect ECONNREFUSED 127.0.0.1:3000)");
  });

  it("neutralizes an ANSI escape carried by the rejection's own message", async () => {
    const error = await networkErrorFrom(new Error("fetch failed\x1b[2K\x1b[1GEnter your token:"));
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(error.message).toContain("fetch failed");
  });

  it("neutralizes an ANSI escape carried by the rejection's cause", async () => {
    const error = await networkErrorFrom(new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND\x1b[2K\x1b[1GEnter your token:") }));
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(error.message).toContain("getaddrinfo ENOTFOUND");
  });

  it("neutralizes an ANSI escape when the rejection isn't an Error at all", async () => {
    const error = await networkErrorFrom("socket hang up\x1b[2K\x1b[1GEnter your token:");
    expect(error.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(error.message).toContain("socket hang up");
  });

  it("omits a non-Error cause rather than rendering a bare 'undefined' as the reason", async () => {
    const error = new Error("fetch failed");
    (error as { cause?: unknown }).cause = { code: "ECONNRESET" };
    expect((await networkErrorFrom(error)).message).toBe("Request to http://ahood.test/x failed (fetch failed)");
  });

  // Justifies sanitizeForTerminal's 200-char default here: Node/undici reasons
  // are short and structured, and the longest realistic one (an OpenSSL string)
  // still fits with room to spare -- per part, so a verbose first half can't
  // crowd out the cause, which is the half that says what actually broke.
  it("does not truncate a realistically long transport reason", async () => {
    const openssl =
      "write EPROTO 4039A5D9D77F0000:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../deps/openssl/openssl/ssl/record/ssl3_record.c:354:";
    expect(openssl.length).toBeGreaterThan(140);
    const error = await networkErrorFrom(new Error("fetch failed", { cause: new Error(openssl) }));
    expect(error.message).toContain(openssl);
  });

  it("still bounds a pathologically long one", async () => {
    const error = await networkErrorFrom(new Error("fetch failed", { cause: new Error("x".repeat(5000)) }));
    expect(error.message).toContain("Request to http://ahood.test/x failed (fetch failed: xxx");
    expect(error.message.length).toBeLessThan(500);
  });
});
