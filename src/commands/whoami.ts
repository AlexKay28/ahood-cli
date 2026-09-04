import { ApiError, apiJson } from "../http.js";
import { resolveToken } from "../credentials.js";

// Mirrors GET /api/v1/profile's response shape. All fields besides
// `username` are nullable in the backend (a profile can be created before
// any of the optional fields are filled in), so they're typed as such here
// too rather than assumed present.
type Profile = {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  github_username: string | null;
};

// Best-effort enrichment: whoami's real job is answering "does this token
// still authenticate?", which is already settled by the time this runs.
// A failure here (network blip, an otherwise-valid token hitting a 500 on
// this specific route, etc.) must never turn a successful auth check into a
// command failure -- so every error is swallowed and callers fall back to
// the plain "Authenticated..." message instead.
async function fetchProfile(): Promise<Profile | undefined> {
  try {
    return await apiJson<Profile>("/api/v1/profile");
  } catch {
    return undefined;
  }
}

export async function whoami(args: string[] = []): Promise<void> {
  const wantsJson = args.includes("--json");
  const token = resolveToken();
  if (!token) {
    // Previously exited 0 here, defeating whoami's purpose as a scriptable
    // auth check -- "no token configured at all" must fail just like "token
    // rejected by the server" does below. Exit 4 ("authentication required
    // or rejected"), not the generic 1 -- this is exactly the case the
    // README's own exit-code table names as the canonical example of 4
    // (ahood-cli#80).
    if (wantsJson) console.log(JSON.stringify({ authenticated: false }));
    else console.error("Not logged in. Run `ahood login` (or set AHOOD_TOKEN).");
    process.exitCode = 4;
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
    const profile = await fetchProfile();
    if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: "session", ...profile }));
    else console.log(profile ? `Authenticated as ${profile.username}.` : "Authenticated.");
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      const profile = await fetchProfile();
      if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: "token", ...profile }));
      else
        console.log(
          profile
            ? `Authenticated as ${profile.username} (personal API token).`
            : "Authenticated with a personal API token.",
        );
      return;
    }
    if (error instanceof ApiError && error.status === 401) {
      // Same exit-4 reasoning as the "no token at all" branch above: the
      // token was rejected by the server, which is the other half of the
      // README's exit-code-4 definition ("or the token was refused").
      if (wantsJson) console.log(JSON.stringify({ authenticated: false, reason: "invalid_token" }));
      else console.error("Not authenticated -- your token is invalid or has been revoked.");
      process.exitCode = 4;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) console.log(JSON.stringify({ authenticated: null, error: message }));
    else console.error(`Could not verify your token: ${message}`);
    process.exitCode = 1;
  }
}
