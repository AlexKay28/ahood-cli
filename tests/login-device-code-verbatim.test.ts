import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../src/commands/login.js";

const API_URL = "http://ahood.test";
const POLL_PREFIX = `${API_URL}/api/v1/auth/cli/device/`;

// WHY THIS FILE EXISTS (ahood#357).
//
// The device code's FORMAT is defined in exactly one place, and that place is
// in the other repository: ahood's lib/auth/device-code.ts. ahood#351 moved it
// there and ahood#355 guards it, but both are confined to ahood. This CLI is
// the half of the round trip that guard cannot see.
//
// What ahood#349 cost. The format had drifted apart across four places and
// nobody could run `ahood login` at all -- a total, deterministic outage. It
// did not look like one. This CLI sends the code as encodeURIComponent(code),
// and the hyphen is an UNRESERVED character under RFC 3986, so it passed
// through untouched, the poll request was well-formed, and the server kept
// answering "pending" until the TTL expired. The user saw "Login timed out".
// Had this CLI instead normalized the code on the way out, the same class of
// bug would be ours, and every test in ahood would still be green.
//
// SO WHAT IS PINNED HERE IS BEHAVIOUR, NOT FORMAT. This CLI's correctness is
// that it is format-AGNOSTIC: the code is an opaque string that it displays and
// hands back untouched. The server canonicalizes whatever arrives
// (canonicalizeDeviceCode, ahood#351), which is exactly why a server-side
// format fix needs no release of this package -- a property worth more than
// deduplicating one small format into a shared dependency, and a property that
// only holds while this file passes.
//
// Asserting a specific alphabet here would therefore be a REGRESSION dressed as
// coverage: it would recreate, in this repository, the second definition those
// three issues existed to remove. Every fixture below is deliberately not a
// code the real mint can produce.
//
// Contract: ahood's docs/adr/backend/0005-device-code-cross-repo-contract.md.

// Each fixture is a string the real mint would never emit, chosen so that the
// realistic regression -- somebody adding a helpful tidy-up to the send path --
// cannot survive it:
//
//   surrounding whitespace  defeats  .trim()
//   lower case              defeats  .toUpperCase()
//   a separator             defeats  .replace(/-/g, "") and friends
//   an interior space       defeats  stripping "whitespace in the middle"
//
// A well-formed code like "ABCD-2345" would round-trip through every one of
// those mutations by luck and prove nothing.
const OPAQUE_CODES: ReadonlyArray<readonly [name: string, code: string]> = [
  ["whitespace, lower case and a separator at once", "  abcd-2345  "],
  ["an interior space", "wxyz 6789"],
  ["no separator and mixed case", "aBcD2345"],
  ["a shape from no format this CLI has ever seen", "zz/9+8%x"],
];

describe("login transmits the device code verbatim (ahood#357)", () => {
  let dir: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-login-verbatim-test-"));
    process.env.HOME = dir;
    delete process.env.XDG_CONFIG_HOME;
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  function stubDeviceFlow(code: string): { pollUrls: string[] } {
    const pollUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/auth/cli/device`) {
          return new Response(
            JSON.stringify({ code, verification_url: `${API_URL}/cli-auth`, expires_in: 600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.startsWith(POLL_PREFIX)) {
          pollUrls.push(url);
          return new Response(JSON.stringify({ status: "approved", token: "ahd_tok" }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );
    return { pollUrls };
  }

  it.each(OPAQUE_CODES)("sends back the exact bytes it was given -- %s", async (_name, code) => {
    const { pollUrls } = stubDeviceFlow(code);

    await login();

    expect(pollUrls).toHaveLength(1);
    const segment = pollUrls[0].slice(POLL_PREFIX.length);

    // The code must still occupy ONE path segment. Without this, a code
    // carrying a "/" would arrive as two segments and reach a different route
    // entirely, and the byte comparison below would be reading the wrong thing.
    expect(segment).not.toContain("/");

    // THE ASSERTION. decodeURIComponent is the exact inverse the server's
    // path-parameter decoding applies, so this is the byte sequence that
    // reaches the route handler -- not merely evidence that encoding succeeded.
    // Byte-for-byte identical to what was minted: no trim, no case change, no
    // separator stripped, nothing re-formatted.
    expect(decodeURIComponent(segment)).toBe(code);
  });

  it("prints the code exactly as received, so the user's browser comparison is meaningful", async () => {
    // The /cli-auth page asks the user to confirm the code in their terminal
    // matches the code in their browser. That comparison is worthless if this
    // CLI renders a tidied-up version of what the server actually stored.
    const code = "  abcd-2345  ";
    stubDeviceFlow(code);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await login();

    const printed = log.mock.calls.map((args) => args.join(" "));
    expect(printed.some((line) => line.includes(code))).toBe(true);
  });
});
