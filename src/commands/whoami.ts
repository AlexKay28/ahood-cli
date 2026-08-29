import { ApiError, apiJson } from "../http.js";
import { resolveToken } from "../credentials.js";

export async function whoami(): Promise<void> {
  const token = resolveToken();
  if (!token) {
    console.log("Not logged in. Run `ahood login`.");
    return;
  }

  // There is no endpoint that returns an identity for a bearer caller yet, so
  // whoami can only answer "does this token still authenticate?". It probes
  // /api/v1/auth/tokens, which is deliberately session-only (Task 3), and
  // reads the STATUS to tell the two failure modes apart -- swallowing every
  // error and printing "Authenticated." unconditionally (as this did) meant a
  // revoked token and a garbage token both reported success with exit code 0.
  //   403 -> resolveCaller accepted the token, the route then rejected it for
  //          being a token rather than a session. The token is valid.
  //   401 -> resolveCaller could not resolve the token at all: unknown,
  //          revoked, or expired.
  try {
    await apiJson<{ tokens: unknown[] }>("/api/v1/auth/tokens");
    // A session-backed caller (only reachable if this ever runs against a
    // cookie-bearing client) -- the token list came back.
    console.log("Authenticated.");
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      console.log("Authenticated with a personal API token.");
      return;
    }
    // 401 and anything else (network failure, 5xx) are both "we could not
    // confirm this token works" -- exit non-zero so `ahood whoami` is
    // usable as a scriptable auth check.
    console.error("Not authenticated -- your token is invalid or has been revoked.");
    process.exitCode = 1;
  }
}
