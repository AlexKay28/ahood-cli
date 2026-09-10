import { getApiUrl } from "./config.js";
import { resolveToken } from "./credentials.js";
import { CLI_NAME, CLI_VERSION } from "./version.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Distinguished from ApiError so index.ts's top-level handler can map it to
// its own exit code -- "the network/transport failed" is a different
// situation for a caller/script than "the server responded with an error".
export class NetworkError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;

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
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    const message = error instanceof Error ? error.message : String(error);
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
//
// Control characters are replaced with a space rather than deleted so that
// stripping can't silently glue two tokens into one misleading word.
//
// Newlines (\x0a) and carriage returns (\x0d) are inside this range and are
// deliberately flattened too: a forged prompt line ("...\n\nEnter your token:")
// needs no escape sequence at all, just a newline, so preserving them would
// leave the spoofing half of the threat model open while closing the escape
// half. The readability cost is small because anything reaching this branch is
// already capped at MAX_ERROR_MESSAGE_LENGTH -- a few lines' worth of text, not
// a stack trace.
//
// Known duplication: this is the same substitution as `sanitizeForTerminal` in
// src/commands/add.ts (ahood-cli#122). It is copied rather than shared on
// purpose -- promoting a shared helper means editing add.ts's call sites, which
// is follow-up refactor work kept out of this security fix; see ahood-cli#127.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

// Defense in depth (ahood-cli#31): the API is expected to never forward a raw
// upstream error body (an HTML block page from a proxy/WAF, a giant stack
// trace, etc.) into `error`, but this CLI shouldn't trust that unconditionally
// -- a regression on any endpoint would otherwise dump multi-KB infra details
// straight to a user's terminal. Anything HTML-shaped or implausibly long for
// a normal error string is replaced with a short, safe summary instead.
export function sanitizeErrorMessage(message: string): string {
  const looksLikeHtml = /<!DOCTYPE|<html[\s>]/i.test(message);
  if (!looksLikeHtml && message.length <= MAX_ERROR_MESSAGE_LENGTH) return message.replace(CONTROL_CHARACTERS, " ");
  // No preview of the raw content: an HTML-shaped body's first bytes are
  // exactly where infra details (e.g. a Cloudflare block page's title, Ray
  // ID) live, so a "helpful" excerpt would leak the same details this
  // exists to suppress. Length alone is safe to report.
  return `Request failed with an unexpected, oversized, or HTML-shaped error response (${message.length} bytes) -- this usually means an upstream proxy/WAF failure, not a problem with your request.`;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);

  if (!res.ok) {
    // The error body may not be valid/object JSON (proxy error pages, an
    // empty body, a literal `null`) -- fall back to the status-only message
    // rather than crashing on `body.error` of something that isn't an object.
    const body: unknown = await res.json().catch(() => undefined);
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? sanitizeErrorMessage((body as { error: string }).error)
        : `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
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
