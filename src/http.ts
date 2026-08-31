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

// Defense in depth (ahood-cli#31): the API is expected to never forward a raw
// upstream error body (an HTML block page from a proxy/WAF, a giant stack
// trace, etc.) into `error`, but this CLI shouldn't trust that unconditionally
// -- a regression on any endpoint would otherwise dump multi-KB infra details
// straight to a user's terminal. Anything HTML-shaped or implausibly long for
// a normal error string is replaced with a short, safe summary instead.
function sanitizeErrorMessage(message: string): string {
  const looksLikeHtml = /<!DOCTYPE|<html[\s>]/i.test(message);
  if (!looksLikeHtml && message.length <= MAX_ERROR_MESSAGE_LENGTH) return message;
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

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Malformed response from ${getApiUrl()}${path}: expected JSON.`);
  }
}
