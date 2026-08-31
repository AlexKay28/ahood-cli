import { ApiError, NetworkError } from "./http.js";

// A hung/black-holed connection throws undici's generic TypeError("fetch
// failed") -- http.ts wraps that into NetworkError so it gets its own exit
// code here, distinct from a server-returned ApiError. Kept in its own
// module (rather than inline in index.ts) so it's importable in tests
// without triggering index.ts's unconditional top-level main() call.
export function exitCodeFor(error: unknown): number {
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
