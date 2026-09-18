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

// The two ways "no profile came back" can happen, per GET /api/v1/profile
// (ahood#336, ahood#340): `provisioning` is the expected, self-resolving
// window between a Clerk signup and the webhook (or reconcile cron) creating
// the `profiles` row -- nothing is wrong and nothing is required of the user.
// `not_found` is a 404 the server did NOT tag `provisioning: true`, i.e. a
// missing profile for some other reason. The two are worded and exited
// differently below; conflating them (as this used to) meant a 30-second-old
// account and a genuinely broken one printed the same generic message.
type ProfileOutcome = { profile?: Profile; profileStatus?: "provisioning" | "not_found" };

export type WhoamiResult =
  | { authenticated: false; reason: "not_logged_in" }
  | { authenticated: false; reason: "invalid_token" }
  | ({ authenticated: true; mode: "session" | "token" } & ProfileOutcome)
  | { authenticated: null; error: string };

// Best-effort enrichment: whoami's real job is answering "does this token
// still authenticate?", which is already settled by the time this runs.
// A failure here (network blip, an otherwise-valid token hitting a 500 on
// this specific route, etc.) must never turn a successful auth check into a
// command failure -- so most errors are swallowed and callers fall back to
// the plain "Authenticated..." message instead. The one exception is a 404,
// which carries a `provisioning` flag worth reading rather than discarding:
// see ProfileOutcome above.
async function fetchProfile(): Promise<ProfileOutcome> {
  try {
    const profile = await apiJson<Profile>("/api/v1/profile");
    return { profile };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const body = error.body;
      const provisioning = !!body && typeof body === "object" && (body as { provisioning?: unknown }).provisioning === true;
      return { profileStatus: provisioning ? "provisioning" : "not_found" };
    }
    return {};
  }
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
    const profileOutcome = await fetchProfile();
    return { authenticated: true, mode: "session", ...profileOutcome };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      const profileOutcome = await fetchProfile();
      return { authenticated: true, mode: "token", ...profileOutcome };
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

  const asToken = result.mode === "token";

  if (result.profileStatus === "not_found") {
    // Distinct from "provisioning" below: the server saw a 404 for this
    // caller's profile and did NOT flag it as the expected provisioning
    // window (ahood#340) -- authentication is genuinely fine (we got this
    // far), but something about the account's profile is actually wrong
    // rather than merely not-created-yet. Exit 5 ("Not found"), the same
    // code exitCodeFor() already gives an ApiError 404 elsewhere -- this is
    // that same class of failure, just decided locally since checkAuth()
    // never throws.
    if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: result.mode, profileStatus: "not_found" }));
    else {
      console.error(
        `Authenticated${asToken ? " with a personal API token" : ""}, but no profile was found for this account -- ` +
          "this is not the usual just-signed-up delay, so something is actually wrong. Try `ahood login` again, and " +
          "if it keeps happening, contact support.",
      );
    }
    process.exitCode = 5;
    return;
  }

  if (result.profileStatus === "provisioning") {
    // The expected, self-resolving window between signup and the profile
    // row being created (ahood#336, ahood#340) -- not a failure of any kind,
    // so this stays exit 0. "Refresh this page" (the web copy's hint) makes
    // no sense here; re-running the command is the CLI-native equivalent.
    if (wantsJson) console.log(JSON.stringify({ authenticated: true, mode: result.mode, profileStatus: "provisioning" }));
    else {
      console.log(
        `Authenticated${asToken ? " with a personal API token" : ""}. Your account is still being set up -- ` +
          "this finishes on its own and needs nothing from you. Run `ahood whoami` again in a bit to see your profile.",
      );
    }
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
