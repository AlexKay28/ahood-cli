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

export type WhoamiResult =
  | { authenticated: false; reason: "not_logged_in" }
  | { authenticated: false; reason: "invalid_token" }
  // profileStatus is set only when the registry answered the profile fetch
  // definitively: "provisioning" (profile 404 whose JSON body carries
  // `provisioning: true` -- the expected, self-resolving window right after
  // signup, backend half of ahood#340) or "not_found" (a bare 404 -- no
  // profile exists and it is not the provisioning window). Absent in every
  // other case, including profile-fetch failures that aren't 404s, so older
  // backends and transient profile-fetch failures behave exactly as before.
  | {
      authenticated: true;
      mode: "session" | "token";
      profile?: Profile;
      profileStatus?: "provisioning" | "not_found";
    }
  | { authenticated: null; error: string };

type ProfileFetch =
  | { state: "present"; profile: Profile }
  | { state: "provisioning" }
  | { state: "not_found" }
  | { state: "unavailable" };

// The flag must positively assert provisioning -- `provisioning: false`, an
// absent flag, or any other shape means "genuinely missing" on a 404.
function bodyFlagsProvisioning(body: unknown): boolean {
  return (body as { provisioning?: unknown } | null | undefined)?.provisioning === true;
}

// Best-effort enrichment: whoami's real job is answering "does this token
// still authenticate?", which is already settled by the time this runs. Only
// the profile 404 is definitive enough to change what whoami reports -- the
// backend tags the expected post-signup window with `provisioning: true` on
// that 404's JSON body (read off ApiError.body), and a bare 404 means no
// profile exists at all (reopened #162; supersedes the earlier exit-7
// design). Everything else (network blip, an otherwise-valid token hitting a
// 500 on this specific route, an unparseable body) is "unavailable": swallowed,
// so a transient profile problem can never turn a successful auth check into
// a command failure -- callers fall back to the plain "Authenticated..."
// message instead.
async function fetchProfileState(): Promise<ProfileFetch> {
  try {
    const profile = await apiJson<Profile>("/api/v1/profile");
    return { state: "present", profile };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      if (bodyFlagsProvisioning(error.body)) return { state: "provisioning" };
      return { state: "not_found" };
    }
    return { state: "unavailable" };
  }
}

// Maps a profile fetch onto the optional fields of the authenticated:true
// result: a present profile spreads as `profile`, a definitive 404 answer as
// `profileStatus`, and "unavailable" as neither (the legacy fallback).
async function profileFields(): Promise<{
  profile?: Profile;
  profileStatus?: "provisioning" | "not_found";
}> {
  const fetched = await fetchProfileState();
  if (fetched.state === "present") return { profile: fetched.profile };
  if (fetched.state === "provisioning" || fetched.state === "not_found") {
    return { profileStatus: fetched.state };
  }
  return {};
}

// Pure auth-status check: no console output, no process.exitCode -- callers
// (the CLI's whoami() below, and the MCP whoami tool) decide how to present
// each outcome. Never throws; every failure mode is a normal return value.
export async function checkAuth(): Promise<WhoamiResult> {
  const token = resolveToken();
  if (!token) {
    return { authenticated: false, reason: "not_logged_in" };
  }

  // There is no endpoint that returns an identity for a bearer caller yet, so
  // this can only answer "does this token still authenticate?". It probes
  // /api/v1/auth/tokens, which is deliberately session-only (Task 3), and
  // reads the STATUS to tell the two failure modes apart -- swallowing every
  // error and reporting success unconditionally (as this used to) meant a
  // revoked token and a garbage token both reported success.
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
    return { authenticated: true, mode: "session", ...(await profileFields()) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return { authenticated: true, mode: "token", ...(await profileFields()) };
    }
    if (error instanceof ApiError && error.status === 401) {
      return { authenticated: false, reason: "invalid_token" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { authenticated: null, error: message };
  }
}

export async function whoami(args: string[] = []): Promise<void> {
  const wantsJson = args.includes("--json");
  const result = await checkAuth();

  if (result.authenticated === false && result.reason === "not_logged_in") {
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

  if (result.authenticated === false && result.reason === "invalid_token") {
    // Same exit-4 reasoning as the "no token at all" branch above: the
    // token was rejected by the server, which is the other half of the
    // README's exit-code-4 definition ("or the token was refused").
    if (wantsJson) console.log(JSON.stringify({ authenticated: false, reason: "invalid_token" }));
    else console.error("Not authenticated -- your token is invalid or has been revoked.");
    process.exitCode = 4;
    return;
  }

  if (result.authenticated === null) {
    if (wantsJson) console.log(JSON.stringify({ authenticated: null, error: result.error }));
    else console.error(`Could not verify your token: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  // Still provisioning (profile 404 tagged provisioning:true): the token
  // itself authenticated, and this is the expected, self-resolving window
  // right after signup -- NOT a failure, so exit stays 0 and no new exit
  // code is introduced (reopened #162). Wording is CLI-appropriate, not the
  // web's "refresh this page" copy.
  if (result.profileStatus === "provisioning") {
    if (wantsJson) {
      console.log(JSON.stringify({ authenticated: true, mode: result.mode, profileStatus: "provisioning" }));
    } else {
      console.log(
        "Your account is still being set up -- this finishes on its own and needs nothing from you. Run `ahood whoami` again in a bit...",
      );
    }
    return;
  }

  // Genuinely missing (bare profile 404, no provisioning flag): distinct
  // from the provisioning window and a failure for scripts -- exit 5, the
  // code exitCodeFor() already maps an ApiError 404 to elsewhere
  // (src/exit-code.ts), not a new constant.
  if (result.profileStatus === "not_found") {
    if (wantsJson) {
      console.log(JSON.stringify({ authenticated: true, mode: result.mode, profileStatus: "not_found" }));
    } else {
      console.error(
        "Authenticated, but no profile exists for your account on the registry (404) -- and this is not the normal post-signup provisioning window, so something may be wrong. Check AHOOD_API_URL or re-run `ahood login`.",
      );
    }
    process.exitCode = 5;
    return;
  }

  if (wantsJson) {
    console.log(JSON.stringify({ authenticated: true, mode: result.mode, ...result.profile }));
    return;
  }
  if (result.mode === "session") {
    console.log(result.profile ? `Authenticated as ${result.profile.username}.` : "Authenticated.");
  } else {
    console.log(
      result.profile
        ? `Authenticated as ${result.profile.username} (personal API token).`
        : "Authenticated with a personal API token.",
    );
  }
}
