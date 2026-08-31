import { apiJson } from "../http.js";
import { getApiUrl } from "../config.js";
import { writeCredentials } from "../credentials.js";

type DeviceCodeResponse = { code: string; verification_url: string; expires_in: number };
type PollResponse = { status: "pending" | "approved"; token?: string };

const DEFAULT_EXPIRES_IN_SECONDS = 600; // 10 minutes, matching the previous timeout loop's real-world duration
const POLL_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(): Promise<void> {
  const { code, verification_url, expires_in } = await apiJson<DeviceCodeResponse>("/api/v1/auth/cli/device", {
    method: "POST",
  });

  console.log(`First, confirm this code matches what you see in your browser: ${code}`);
  console.log(`Open ${verification_url} to approve.`);

  // expires_in is server-supplied; a missing/non-finite value previously
  // produced `Date.now() + undefined * 1000` = NaN, so `Date.now() < NaN` is
  // always false and the poll loop's body never ran even once -- login
  // failed instantly with "timed out" instead of ever actually polling.
  const seconds = Number.isFinite(expires_in) && expires_in > 0 ? expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    await sleep(2000);
    let res: Response;
    let body: PollResponse;
    try {
      // Poll against the CONFIGURED API host (getApiUrl()), not a URL derived
      // from the server-supplied verification_url -- that field is only ever
      // shown to the human, never used to build a request, so a compromised
      // or redirected registry response can't point this at a host that
      // then harvests the device code and hands back an attacker's token.
      res = await apiFetchWithTimeout(`/api/v1/auth/cli/device/${encodeURIComponent(code)}`);
      body = (await res.json()) as PollResponse;
    } catch (error) {
      // A THROWN fetch (DNS blip, dropped socket, a body that isn't JSON) is
      // transient by nature, and this loop runs for up to ten minutes while a
      // human walks to their browser -- one bad network moment must not kill
      // a login that is about to succeed. HTTP *statuses* are still decided
      // below; only the transport failure is retried. The deadline is
      // untouched, so this cannot loop forever.
      console.error(`Polling failed (${error instanceof Error ? error.message : String(error)}); retrying...`);
      continue;
    }
    if (res.status === 200 && body.status === "approved" && body.token) {
      writeCredentials({ token: body.token });
      console.log("Logged in.");
      return;
    }
    if (res.status === 410 || res.status === 404) {
      throw new Error("This login was cancelled or expired. Run `ahood login` again.");
    }
    // status === "pending" -- keep polling.
  }
  throw new Error("Login timed out. Run `ahood login` again.");
}

// Not apiJson: a non-2xx poll response ("pending", still-provisioning, etc.)
// is expected and must not throw -- the status code is inspected by the
// caller instead. Still routed through the same trusted host + a bounded
// timeout, unlike the raw, unbounded `fetch` this replaced.
async function apiFetchWithTimeout(path: string): Promise<Response> {
  return fetch(`${getApiUrl()}${path}`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
}
