import { apiJson } from "../http.js";
import { writeCredentials } from "../credentials.js";

type DeviceCodeResponse = { code: string; verification_url: string; expires_in: number };
type PollResponse = { status: "pending" | "approved" } & { token?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(): Promise<void> {
  const { code, verification_url, expires_in } = await apiJson<DeviceCodeResponse>("/api/v1/auth/cli/device", {
    method: "POST",
  });

  console.log(`First, confirm this code matches what you see in your browser: ${code}`);
  console.log(`Open ${verification_url} to approve.`);

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    let res: Response;
    let body: PollResponse;
    try {
      res = await fetch(`${verification_url.split("?")[0].replace("/cli-auth", "")}/api/v1/auth/cli/device/${code}`);
      body = await res.json();
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
