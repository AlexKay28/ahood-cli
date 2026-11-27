import { ApiError, apiJson, parseRetryAfterMs, sanitizeErrorMessage } from "../http.js";
import { getApiUrl } from "../config.js";
import { writeCredentials } from "../credentials.js";
import { parseArgs } from "../flags.js";
import { jsonRequested } from "../json-output.js";
import { UsageError } from "../usage-error.js";

// device_code (ahood-cli#1320 contract §1/§3): a one-shot secret the START
// response carries ONLY to let this CLI re-identify itself on every poll via
// the X-Ahood-Device-Code header -- never the code's own user/verification
// story. Optional because an older server hasn't been taught to send it yet
// (contract §2: the server still accepts a header-less poll in that case).
type DeviceCodeResponse = { code: string; verification_url: string; expires_in: number; device_code?: string };
type PollResponse = { status: "pending" | "approved"; token?: string };

// A terminal, non-retryable poll response that carries a JSON `error`
// (ahood-cli#1320 contract §3): any 4xx other than 429/404/410 (already
// handled elsewhere in the loop), or any 5xx. Narrowed structurally rather
// than cast, since the poll body's shape otherwise has nothing in common
// with PollResponse.
function structuredError(body: unknown): body is { error: string } {
  return !!body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string";
}

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

export async function login(args: string[] = []): Promise<void> {
  // index.ts used to drop login's args, so a typo'd flag started a device-code
  // flow anyway (ahood-cli#260).
  //
  // --json is refused rather than tolerated (ahood-cli#251): the flow prints a
  // code for a person to compare in a browser and then waits on them, so it
  // has no single document to emit -- and a caller that wants JSON is
  // unattended, which is what AHOOD_TOKEN is for.
  if (jsonRequested(args)) {
    throw new UsageError(
      "ahood login is interactive (it waits for you to approve a code in the browser) and has no --json output. " +
        "For unattended use, set AHOOD_TOKEN instead.\nUsage: ahood login",
    );
  }
  parseArgs(args, { usage: "Usage: ahood login", max: 0 });
  // device_code is destructured here and ONLY ever passed to
  // apiFetchWithTimeout below, which turns it into a poll header -- per
  // contract §1 it must never be printed or persisted, unlike `code`, which
  // is deliberately echoed to the terminal a few lines down.
  const { code, verification_url, expires_in, device_code } = await apiJson<DeviceCodeResponse>(
    "/api/v1/auth/cli/device",
    { method: "POST" },
  );

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
      res = await apiFetchWithTimeout(`/api/v1/auth/cli/device/${encodeURIComponent(code)}`, device_code);
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
    let body: unknown;
    try {
      body = await res.json();
    } catch (error) {
      // A genuinely malformed/non-JSON body on a non-terminal status (e.g. a
      // transient 502 while still pending) is the same kind of transient
      // blip a thrown fetch above is -- retry rather than fail the whole
      // login.
      console.error(`Polling failed (${error instanceof Error ? error.message : String(error)}); retrying...`);
      continue;
    }
    // ahood-cli#1320 contract §3: any OTHER 4xx (409 too many tokens, say)
    // or any 5xx, carrying a JSON `error`, is final -- not the transient
    // blip a malformed body above is treated as. 429/404/410 are already
    // handled above this point; everything else non-2xx with no parseable
    // `error` falls through to "pending" below exactly as before, since
    // there is nothing here to distinguish it from a still-provisioning
    // response the server simply didn't annotate.
    //
    // Routed through the same ApiError + exitCodeFor every other command
    // uses (401/403 -> 4, a non-401/403 4xx -> 2, 5xx -> 6) instead of a
    // bespoke error class, so a caller branching on login's exit code gets
    // the same documented table the README promises for every other
    // command.
    if (!res.ok && structuredError(body)) {
      throw new ApiError(res.status, sanitizeErrorMessage(body.error));
    }
    const poll = body as PollResponse;
    if (res.status === 200 && poll.status === "approved" && poll.token) {
      writeCredentials({ token: poll.token });
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
//
// deviceCode (ahood-cli#1320 contract §2/§3) goes out as the
// X-Ahood-Device-Code header -- a header, never a query param, so it can't
// end up in a URL or a log line the way a query string would. Omitted
// (undefined) against an older server that never sent one in the START
// response, which the server treats exactly as it does today (contract
// §2's "if header absent -> current behaviour").
async function apiFetchWithTimeout(path: string, deviceCode?: string): Promise<Response> {
  const headers = deviceCode ? { "X-Ahood-Device-Code": deviceCode } : undefined;
  return fetch(`${getApiUrl()}${path}`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS), headers });
}
