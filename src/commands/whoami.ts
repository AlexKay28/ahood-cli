import { ApiError, apiJson } from "../http.js";
import { resolveToken } from "../credentials.js";
import { EXIT_PROVISIONING } from "../exit-code.js";

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
  // profileState is set only when the registry answered definitively that
  // there is no usable profile behind this token: "provisioning" (account
  // created, backend setup still in flight -- ahood#340, server side
  // ahood#337) or "missing" (no profile exists at all). Absent in every
  // other case, including the legacy fallbacks, so older backends and
  // transient profile-fetch failures behave exactly as before.
  | {
      authenticated: true;
      mode: "session" | "token";
      profile?: Profile;
      profileState?: "provisioning" | "missing";
    }
  | { authenticated: null; error: string };

// Issue ahood#337 taught GET /api/v1/profile to distinguish "still
// provisioning" from "no such profile", carrying the provisioning state
// inside a 200 profile response. The exact field name is not discoverable
// from this repo (no copy of the server contract is vendored here), so the
// plausible optional fields are read defensively and the check fires only on
// values that *positively assert* provisioning -- an unrelated "status":
// "active"-style field, or its outright absence on older backends, must not
// change whoami's behavior.
function profileIndicatesProvisioning(profile: unknown): boolean {
  if (typeof profile !== "object" || profile === null) return false;
  const fields = profile as Record<string, unknown>;
  for (const key of ["provisioning", "provisioning_state", "provisioning_status", "status", "state"]) {
    const value = fields[key];
    if (typeof value === "string" && (value === "provisioning" || value === "pending")) return true;
    if (key.startsWith("provisioning") && value === true) return true;
  }
  return false;
}

type ProfileFetch =
  | { state: "present"; profile: Profile | undefined }
  | { state: "provisioning" }
  | { state: "missing" }
  | { state: "unavailable" };

// Best-effort enrichment: whoami's real job is answering "does this token
// still authenticate?", which is already settled by the time this runs.
// Only two profile answers are definitive enough to change what whoami
// reports: a 200 whose body positively asserts provisioning, and a 404 (no
// profile exists -- the same status exitCodeFor maps to the documented
// not-found code 5). Everything else (network blip, an otherwise-valid token
// hitting a 500 on this specific route, an empty body, etc.) is
// "unavailable": swallowed, so a transient profile problem can never turn a
// successful auth check into a command failure -- callers fall back to the
// plain "Authenticated..." message instead.
async function fetchProfileState(): Promise<ProfileFetch> {
  try {
    const profile = await apiJson<Profile>("/api/v1/profile");
    if (profileIndicatesProvisioning(profile)) return { state: "provisioning" };
    return { state: "present", profile };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { state: "missing" };
    return { state: "unavailable" };
  }
}

function whoamiResultFor(mode: "session" | "token", fetch: ProfileFetch): Extract<WhoamiResult, { authenticated: true }> {
  if (fetch.state === "provisioning") return { authenticated: true, mode, profileState: "provisioning" };
  if (fetch.state === "missing") return { authenticated: true, mode, profileState: "missing" };
  if (fetch.state === "present") return { authenticated: true, mode, profile: fetch.profile };
  return { authenticated: true, mode };
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
    return whoamiResultFor("session", await fetchProfileState());
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return whoamiResultFor("token", await fetchProfileState());
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

  if (result.profileState === "provisioning") {
    // The token is fine -- what's missing is the profile behind it, because
    // backend setup for a freshly created account is still in flight
    // (ahood#340). Exit EXIT_PROVISIONING (7) so a script can tell "wait and
    // retry" apart from every other outcome. Deliberately terminal wording:
    // the web REFRESH_HINT copy is kept out of the API body, and "refresh
    // this page" makes no sense here anyway.
    if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: result.mode, state: "provisioning" }));
    else
      console.error(
        "Account created -- the registry is still setting it up. This finishes on its own; try again in a minute.",
      );
    process.exitCode = EXIT_PROVISIONING;
    return;
  }

  if (result.profileState === "missing") {
    // Definitive "no profile" from the registry (404 on the profile route):
    // a real not-found, not a transient failure, so it reuses the documented
    // not-found exit code 5 rather than the generic 1. Distinct from 7 so a
    // caller never mistakes "retry in a minute" for "this token has no
    // profile at all".
    if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: result.mode, state: "missing" }));
    else console.error("Authenticated, but the registry has no profile for this account.");
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
