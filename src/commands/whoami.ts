import { ApiError, apiJson } from "../http.js";
import { resolveToken } from "../credentials.js";

export async function whoami(args: string[] = []): Promise<void> {
  const wantsJson = args.includes("--json");
  const token = resolveToken();
  if (!token) {
    // Previously exited 0 here, defeating whoami's purpose as a scriptable
    // auth check -- "no token configured at all" must fail just like "token
    // rejected by the server" does below.
    if (wantsJson) console.log(JSON.stringify({ authenticated: false }));
    else console.error("Not logged in. Run `ahood login` (or set AHOOD_TOKEN).");
    process.exitCode = 1;
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
  //   anything else (network failure, 5xx, timeout) is NOT the same as an
  //          invalid token, and is reported as its own distinct failure.
  try {
    await apiJson<{ tokens: unknown[] }>("/api/v1/auth/tokens");
    // A session-backed caller (only reachable if this ever runs against a
    // cookie-bearing client) -- the token list came back.
    if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: "session" }));
    else console.log("Authenticated.");
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: "token" }));
      else console.log("Authenticated with a personal API token.");
      return;
    }
    if (error instanceof ApiError && error.status === 401) {
      if (wantsJson) console.log(JSON.stringify({ authenticated: false, reason: "invalid_token" }));
      else console.error("Not authenticated -- your token is invalid or has been revoked.");
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) console.log(JSON.stringify({ authenticated: null, error: message }));
    else console.error(`Could not verify your token: ${message}`);
    process.exitCode = 1;
  }
}
