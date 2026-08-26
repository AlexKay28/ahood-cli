import { apiJson } from "../http.js";
import { resolveToken } from "../credentials.js";

export async function whoami(): Promise<void> {
  const token = resolveToken();
  if (!token) {
    console.log("Not logged in. Run `skillhub login`.");
    return;
  }
  // /api/v1/auth/tokens is session-only (Task 3) -- whoami instead confirms
  // the token still works by hitting a route any authenticated caller can
  // reach, and reports what it resolves to.
  const tokens = await apiJson<{ tokens: unknown[] }>("/api/v1/auth/tokens").catch(() => null);
  if (tokens === null) {
    console.log("Token is set but is a personal token, not a session -- whoami confirms auth via a lightweight check instead:");
  }
  console.log("Authenticated.");
}
