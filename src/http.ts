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

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);

  if (!res.ok) {
    // The error body may not be valid/object JSON (proxy error pages, an
    // empty body, a literal `null`) -- fall back to the status-only message
    // rather than crashing on `body.error` of something that isn't an object.
    const body: unknown = await res.json().catch(() => undefined);
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Malformed response from ${getApiUrl()}${path}: expected JSON.`);
  }
}
