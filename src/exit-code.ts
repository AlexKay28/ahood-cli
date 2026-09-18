import { ApiError, NetworkError } from "./http.js";
import { UsageError } from "./usage-error.js";

// `ahood whoami` against an account whose backend setup is still in flight
// (ahood#340). Deliberately not 6: that code already means network/5xx, and a
// caller branching on 7 must be able to tell "the fix is waiting a minute --
// setup finishes on its own" apart from "the transport failed". Documented in
// README's exit-code table next to 5, which covers the sibling
// missing-profile case.
export const EXIT_PROVISIONING = 7;

// A hung/black-holed connection throws undici's generic TypeError("fetch
// failed") -- http.ts wraps that into NetworkError so it gets its own exit
// code here, distinct from a server-returned ApiError. Kept in its own
// module (rather than inline in index.ts) so it's importable in tests
// without triggering index.ts's unconditional top-level main() call.
export function exitCodeFor(error: unknown): number {
  // A local validation failure (missing/malformed argument, bad flag value)
  // is exactly the "bad arguments" half of exit code 2's documented meaning
  // -- same code the server-rejected branch below already uses, so a caller
  // branching on exit code sees one consistent "fix your input" signal
  // regardless of whether the check ran locally or round-tripped to the
  // server (ahood-cli#80).
  if (error instanceof UsageError) return 2;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return 4;
    if (error.status === 404) return 5;
    // A 5xx is an upstream/server-side failure, not something wrong with the
    // request -- previously fell through to 2 ("usage/validation error"),
    // which told scripts/agents to fix their input when the actual problem
    // was on the server (ahood-cli#31). Treated like a network/transport
    // failure (6) since neither is something retrying with different input
    // would fix.
    if (error.status >= 500) return 6;
    return 2;
  }
  if (error instanceof NetworkError) return 6;
  return 1;
}
