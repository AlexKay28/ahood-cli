import { getApiUrl } from "./config.js";
import { resolveToken } from "./credentials.js";
import { sanitizeForTerminal } from "./terminal-safe.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

export class ApiError extends Error {
  // The parsed JSON error body, when there was one and it parsed as an
  // object -- not just the `.error` string already folded into `message`.
  // whoami.ts needs this to read the `provisioning` flag GET /api/v1/profile
  // sets on a 404 for "row not provisioned yet" and tell it apart from a 404
  // that means something else, which `message` alone can't do once it's been
  // through sanitizeErrorMessage.
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

// Distinguished from ApiError so index.ts's top-level handler can map it to
// its own exit code -- "the network/transport failed" is a different
// situation for a caller/script than "the server responded with an error".
export class NetworkError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;

// ahood-cli#159: 429 policy. The registry rate-limits many endpoints the CLI
// calls directly, and every limited endpoint answers with a Retry-After. Two
// bounded retries, then a failure that says what actually happened ("rate
// limited", with the server's own wait) instead of a generic status message
// that reads like a registry bug.
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_FIRST_WAIT_MS = 1_000;
// Cap on a single backoff hop, however large the server's Retry-After is: a
// CLI must not silently hang for minutes on one header, and the final error
// still reports the server's uncapped ask.
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-After is seconds per RFC 7231 ("120"), but the same RFC also allows an
// HTTP-date and every rate limiter is one refactor away from switching shape --
// so parse both, defensively. Anything unparseable comes back as undefined so
// callers fall back to their own backoff rather than trusting garbage.
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return undefined;
}

// A hung/black-holed server would otherwise stall the process indefinitely --
// relevant since this CLI is meant to run unattended in CI and be driven by
// agents. Callers (e.g. publish's upload) can still pass their own `signal`.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = resolveToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", `${CLI_NAME}/${CLI_VERSION}`);
  try {
    return await fetch(`${getApiUrl()}${path}`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      ...init,
      headers,
    });
  } catch (error) {
    // The `instanceof Error` guard on the cause is load-bearing, not defensive
    // noise: `cause` is `unknown`, and optional-chaining into `.message`
    // instead would print a bare "undefined" as the reason a request failed
    // (ahood-cli#129). Dropping the reason entirely is the better failure mode.
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${sanitizeForTerminal(error.cause.message)}` : "";
    const message = sanitizeForTerminal(error instanceof Error ? error.message : error);
    throw new NetworkError(`Request to ${getApiUrl()}${path} failed (${message}${cause})`);
  }
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

// The HTML/length checks below (ahood-cli#31) let a *short, non-HTML* body
// through verbatim, which meant an error string could still carry ANSI escapes
// straight to the terminal (ahood-cli#127). That matters here more than in the
// archive-content path ahood-cli#122 hardened, because sanitizeErrorMessage
// sits on every apiJson call in the CLI -- including `add`, which prints
// server-sourced text immediately before a masked secret prompt, the exact
// moment a cursor-movement/line-clear sequence can repaint what the user sees.
// See src/terminal-safe.ts for what that substitution does and why.
//
// Defense in depth (ahood-cli#31): the API is expected to never forward a raw
// upstream error body (an HTML block page from a proxy/WAF, a giant stack
// trace, etc.) into `error`, but this CLI shouldn't trust that unconditionally
// -- a regression on any endpoint would otherwise dump multi-KB infra details
// straight to a user's terminal. Anything HTML-shaped or implausibly long for
// a normal error string is replaced with a short, safe summary instead.
export function sanitizeErrorMessage(message: string): string {
  const looksLikeHtml = /<!DOCTYPE|<html[\s>]/i.test(message);
  // The length argument is belt-and-braces, not behavior: this branch already
  // guarantees `message.length <= MAX_ERROR_MESSAGE_LENGTH`, and an oversized
  // body takes the generic-summary path below instead.
  if (!looksLikeHtml && message.length <= MAX_ERROR_MESSAGE_LENGTH) return sanitizeForTerminal(message, MAX_ERROR_MESSAGE_LENGTH);
  // No preview of the raw content: an HTML-shaped body's first bytes are
  // exactly where infra details (e.g. a Cloudflare block page's title, Ray
  // ID) live, so a "helpful" excerpt would leak the same details this
  // exists to suppress. Length alone is safe to report.
  return `Request failed with an unexpected, oversized, or HTML-shaped error response (${message.length} bytes) -- this usually means an upstream proxy/WAF failure, not a problem with your request.`;
}

// ahood-cli#159 (finding 5): during an outage the registry answered a request
// with 402 and an HTML body -- a client expecting JSON got a parse-shaped
// failure ("Request failed with status 402") that named none of what actually
// happened. These are the statuses that plausibly mean "the whole registry is
// down or blocked" rather than "your specific request was rejected": the 5xx
// family, plus 402 (this incident's status -- a billing/quota gate in front of
// the registry is exactly the kind of thing that fails open with an infra page
// rather than a JSON error).
//
// Deliberately NOT extended to 401/403/404/410/429: those already have their
// own well-understood meanings elsewhere in this CLI (see exit-code.ts,
// login.ts's device-code polling, whoami.ts's provisioning check) and, unlike
// a 5xx or a paywall, a body-less/non-JSON response on one of them is far more
// likely to be "this particular endpoint just doesn't send a body on this
// status" than "the registry is down". Treating those as an outage too would
// overfit this one incident's status code into a much broader claim than the
// evidence supports.
const LIKELY_OUTAGE_STATUSES = new Set([402, 500, 502, 503, 504]);

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  // ahood-cli#159: 429 is its own case, before the generic !res.ok handling.
  // It means "you are asking too fast", and the server tells us exactly when
  // to come back -- surface neither as a generic error, and retry a bounded
  // number of times first. Every other status keeps its exact previous
  // handling below.
  for (let attempt = 0; ; attempt++) {
    const res = await apiFetch(path, init);

    if (res.status === 429) {
      // Drain the rejected body so undici releases the socket instead of
      // keeping it checked out while we wait.
      await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      if (attempt < RATE_LIMIT_MAX_RETRIES) {
        // No usable Retry-After -> exponential (1s, 2s), the same fallback
        // shape the login poll uses. One wait never exceeds the cap.
        const waitMs = Math.min(retryAfterMs ?? RATE_LIMIT_FIRST_WAIT_MS * 2 ** attempt, RATE_LIMIT_MAX_WAIT_MS);
        await sleep(waitMs);
        continue;
      }
      // Retries exhausted. Report the server's own ask (not our capped wait):
      // that is the number the user needs to act on.
      const seconds = Math.ceil((retryAfterMs ?? RATE_LIMIT_FIRST_WAIT_MS * 2 ** RATE_LIMIT_MAX_RETRIES) / 1000);
      throw new ApiError(429, `Rate limited -- try again in ${seconds} seconds.`);
    }

    if (!res.ok) {
      // The error body may not be valid/object JSON (proxy error pages, an
      // empty body, a literal `null`) -- fall back to the status-only message
      // rather than crashing on `body.error` of something that isn't an object.
      const body: unknown = await res.json().catch(() => undefined);
      const hasStructuredError = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string";
      const message = hasStructuredError
        ? sanitizeErrorMessage((body as { error: string }).error)
        : LIKELY_OUTAGE_STATUSES.has(res.status)
          ? `The registry appears to be unavailable (HTTP ${res.status}).`
          : `Request failed with status ${res.status}`;
      throw new ApiError(res.status, message, body);
    }

    // A 204 No Content (or any 2xx with an empty body) has nothing to parse --
    // res.json() throws on empty input, which previously surfaced as a
    // generic "Malformed response" error even though the request succeeded
    // (ahood-cli#103). Callers that don't need response data (e.g. token
    // revoke, which awaits this without using the result) get `undefined`
    // back instead of a spurious failure.
    const text = await res.text();
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Malformed response from ${getApiUrl()}${path}: expected JSON.`);
    }
  }
}
