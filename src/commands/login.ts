import { apiJson, parseRetryAfterMs } from "../http.js";
import { getApiUrl } from "../config.js";
import { writeCredentials } from "../credentials.js";

type DeviceCodeResponse = { code: string; verification_url: string; expires_in: number };
type PollResponse = { status: "pending" | "approved"; token?: string };

const DEFAULT_EXPIRES_IN_SECONDS = 600; // 10 minutes, matching the previous timeout loop's real-world duration
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
// ahood-cli#159: cap on a single 429 backoff hop, same policy as apiJson's
// rate-limit retry -- however large the server's Retry-After, one wait stays
// bounded, and the deadline check below keeps the loop inside expires_in.
const RATE_LIMIT_MAX_BACKOFF_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(): Promise<void> {
  const { code, verification_url, expires_in } = await apiJson<DeviceCodeResponse>("/api/v1/auth/cli/device", {
    method: "POST",
  });

  // Printed VERBATIM, deliberately not through sanitizeForTerminal the way
  // `add` treats server-supplied text: this line exists so the user can
  // compare it against the code on the /cli-auth page, and a tidied-up
  // rendering would make that comparison meaningless. Pinned by
  // tests/login-device-code-verbatim.test.ts (ahood#357).
  console.log(`First, confirm this code matches what you see in your browser: ${code}`);
  console.log(`Open ${verification_url} to approve.`);

  // expires_in is server-supplied; a missing/non-finite value previously
  // produced `Date.now() + undefined * 1000` = NaN, so `Date.now() < NaN` is
  // always false and the poll loop's body never ran even once -- login
  // failed instantly with "timed out" instead of ever actually polling.
  const seconds = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  const deadline = Date.now() + seconds * 1000;

  // ahood-cli#159: when the registry rate-limits the poll, `backoffMs` carries
  // the wait for the NEXT poll -- 429 must not `continue` on the normal
  // cadence, which is the retry-storm shape: the client answers "you are
  // asking too often" by asking again on the same schedule, against an
  // endpoint that can least afford it.
  let backoffMs: number | undefined;
  let consecutive429s = 0;
  // Whether the loop ever saw a 429 -- the timeout message below can then say
  // why the window ran out instead of blaming the user's pace.
  let wasRateLimited = false;

  while (Date.now() < deadline) {
    let waitMs = POLL_INTERVAL_MS;
    if (backoffMs !== undefined) {
      waitMs = backoffMs;
      backoffMs = undefined;
      // The 429 backoff counts against the login deadline like every other
      // wait: a server that keeps answering "wait 60s" must not stretch the
      // loop past expires_in -- and past expiry the device code is dead, so
      // polling after the wait would be pointless anyway.
      if (Date.now() + waitMs >= deadline) break;
    }
    await sleep(waitMs);
    let res: Response;
    try {
      // Poll against the CONFIGURED API host (getApiUrl()), not a URL derived
      // from the server-supplied verification_url -- that field is only ever
      // shown to the human, never used to build a request, so a compromised
      // or redirected registry response can't point this at a host that
      // then harvests the device code and hands back an attacker's token.
      //
      // `code` is sent VERBATIM and must stay that way: do not trim it,
      // change its case, strip its separator or otherwise tidy it. The format
      // is defined once, in ahood's lib/auth/device-code.ts, and the server
      // canonicalizes whatever arrives -- so this CLI stays format-agnostic
      // and a server-side format fix needs no release of this package. In
      // ahood#349 that property was all that stood between a bad ten-minute
      // "Login timed out" and a bad error: the hyphen happens to be
      // unreserved, so encodeURIComponent left it alone. Pinned by
      // tests/login-device-code-verbatim.test.ts; contract in ahood's
      // docs/adr/backend/0005-device-code-cross-repo-contract.md (ahood#357).
      res = await apiFetchWithTimeout(`/api/v1/auth/cli/device/${encodeURIComponent(code)}`);
    } catch (error) {
      // A THROWN fetch (DNS blip, dropped socket) is transient by nature, and
      // this loop runs for up to ten minutes while a human walks to their
      // browser -- one bad network moment must not kill a login that is
      // about to succeed. The deadline is untouched, so this cannot loop
      // forever.
      console.error(`Polling failed (${error instanceof Error ? error.message : String(error)}); retrying...`);
      continue;
    }
    // Checked BEFORE res.json(): these are terminal statuses regardless of
    // body shape, so a non-JSON body on them (e.g. a proxy/WAF error page --
    // the same threat class sanitizeErrorMessage guards against elsewhere)
    // must fail fast here instead of throwing inside the try below and being
    // swallowed as "transient, retry" for up to ten minutes (ahood-cli#104).
    if (res.status === 410 || res.status === 404) {
      throw new Error("This login was cancelled or expired. Run `ahood login` again.");
    }
    if (res.status === 429) {
      // ahood-cli#159: the registry has said stop. Back off by Retry-After
      // (exponentially, 1s doubling, when the header is absent/unparseable)
      // instead of polling on -- and let the deadline check at the top of the
      // loop bound the total time, so rate limiting cannot extend the window.
      wasRateLimited = true;
      consecutive429s++;
      // Drain the rejected body so the socket is released while we wait.
      await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      const wait = Math.min(retryAfterMs ?? 1_000 * 2 ** (consecutive429s - 1), RATE_LIMIT_MAX_BACKOFF_MS);
      backoffMs = wait;
      console.error(`Rate limited while polling; waiting ${Math.ceil(wait / 1000)}s before trying again...`);
      continue;
    }
    consecutive429s = 0;
    let body: PollResponse;
    try {
      body = (await res.json()) as PollResponse;
    } catch (error) {
      // A genuinely malformed/non-JSON body on a non-terminal status (e.g. a
      // transient 502 while still pending) is the same kind of transient
      // blip a thrown fetch above is -- retry rather than fail the whole
      // login.
      console.error(`Polling failed (${error instanceof Error ? error.message : String(error)}); retrying...`);
      continue;
    }
    if (res.status === 200 && body.status === "approved" && body.token) {
      writeCredentials({ token: body.token });
      console.log("Logged in.");
      return;
    }
    // status === "pending" -- keep polling.
  }
  throw new Error(
    wasRateLimited
      ? "Login timed out -- the registry kept rate limiting the poll. Wait a bit and run `ahood login` again."
      : "Login timed out. Run `ahood login` again.",
  );
}

// Not apiJson: a non-2xx poll response ("pending", still-provisioning, etc.)
// is expected and must not throw -- the status code is inspected by the
// caller instead. Still routed through the same trusted host + a bounded
// timeout, unlike the raw, unbounded `fetch` this replaced.
async function apiFetchWithTimeout(path: string): Promise<Response> {
  return fetch(`${getApiUrl()}${path}`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
}
