import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { apiFetch, apiJson, ApiError, NetworkError, sanitizeErrorMessage } from "../src/http.js";
import { CLI_NAME, CLI_VERSION } from "../src/version.js";

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

// ahood-cli#159 (finding 4): the README now documents this header's exact
// shape as a compatibility surface a WAF/firewall allowlist rule may be
// scoped against, so a silent change to its format is worse here than in
// most strings this CLI sends -- pin it so that claim stays true.
describe("User-Agent header (ahood-cli#159)", () => {
  useStubbedApi();

  it("sends '<name>/<version>', matching what the README documents as a stable compatibility surface", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/x");

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(requestInit.headers);
    expect(headers.get("User-Agent")).toBe(`${CLI_NAME}/${CLI_VERSION}`);
  });
});

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

// ahood-cli#159 (finding 5): a non-JSON error body on a status that plausibly
// means the whole registry is down (402, or a 5xx) should say so, rather than
// failing on the parse with a generic status message that names none of what
// actually happened. Scoped to a fixed set of "looks systemic" statuses --
// asserted here alongside a status NOT in that set, so a regression can't
// widen it into every 4xx just because a body happened to be missing.
describe("apiJson outage detection on a non-JSON error body (ahood-cli#159)", () => {
  useStubbedApi();

  it("reports an outage for a 402 with an HTML body, instead of failing on the parse", async () => {
    const html = "<html><body>Payment gateway unavailable</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 402, headers: { "content-type": "text/html" } })));

    let caught: unknown;
    try {
      await apiJson("/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toBe("The registry appears to be unavailable (HTTP 402).");
  });

  it("reports an outage for a 402 with no body at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 402 })));

    await expect(apiJson("/x")).rejects.toThrow("The registry appears to be unavailable (HTTP 402).");
  });

  it.each([500, 502, 503, 504])("reports an outage for a %i with a non-JSON body", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream connect error", { status })));

    await expect(apiJson("/x")).rejects.toThrow(`The registry appears to be unavailable (HTTP ${status}).`);
  });

  it("still uses the structured error, not the outage message, when a systemic-status body does parse as JSON with .error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Specific validation failure" }), { status: 500 })));

    await expect(apiJson("/x")).rejects.toThrow("Specific validation failure");
  });

  it("does NOT treat a body-less 404 as an outage -- only the fixed systemic-status set gets the new message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(apiJson("/x")).rejects.toThrow("Request failed with status 404");
  });

  it("does NOT treat a non-JSON 401 body as an outage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 401 })));

    await expect(apiJson("/x")).rejects.toThrow("Request failed with status 401");
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

// ahood-cli#159: the registry rate-limits many endpoints the CLI calls and
// sends Retry-After on every one of them. apiJson must wait that out, retry a
// bounded number of times, and only then fail -- with a message that names
// the server's ask -- instead of surfacing a generic status error. All waits
// below run on fake timers, so the timings are asserted exactly.
describe("apiJson 429 handling (ahood-cli#159)", () => {
  useStubbedApi();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out a 429's Retry-After and retries, instead of failing the request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = expect(apiJson("/x")).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(2_999); // still inside the 3s the server asked for
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to exponential backoff (1s, then 2s) when Retry-After is absent", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = expect(apiJson("/x")).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1); // first backoff is 1s
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2); // second backoff doubled to 2s
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never sleeps more than 30s in one hop, however large the server's Retry-After is", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = expect(apiJson("/x")).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1); // a 120s ask is capped at a 30s wait
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it("tolerates an HTTP-date Retry-After by converting it to a wait from now", async () => {
    vi.useFakeTimers();
    // toUTCString truncates milliseconds, so the wait the code computes from
    // this header is 9_001..10_000ms; derive the exact expectation from the
    // same fake clock the code reads, and assert the timing precisely.
    const at = new Date(Date.now() + 10_000).toUTCString();
    const expectedWaitMs = Date.parse(at) - Date.now();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": at } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = expect(apiJson("/x")).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(expectedWaitMs - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // date form honored, to the millisecond
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it("ignores an unparseable Retry-After and uses its own backoff instead", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "not-a-date" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = expect(apiJson("/x")).resolves.toEqual({ ok: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1); // fell back to the 1s exponential first hop
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it("after two exhausted retries fails with a rate-limit message naming the server's seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "Retry-After": "7" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Handlers attached before any timer runs, so a rejection mid-advance is
    // never unhandled.
    const outcome = apiJson("/x").then(
      () => {
        throw new Error("expected apiJson to reject");
      },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000); // covers both 7s backoffs with room to spare

    const caught = (await outcome) as ApiError;
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.status).toBe(429);
    expect(caught.message).toMatch(/rate limited/i);
    expect(caught.message).toMatch(/try again in 7 seconds/);
    // The original request plus two bounded retries -- then give up and say so.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("leaves 401/403/404/410 handling untouched -- no retry, body error passed through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "This token's scopes do not include 'publish'" }), { status: 403 })),
    );
    // Same single-call, immediate-rejection behavior the 403 test above pins;
    // asserted here against 429's neighbors so a regression in the retry loop
    // can't swallow non-429 statuses.
    await expect(apiJson("/x")).rejects.toThrow("This token's scopes do not include 'publish'");
  });
});
