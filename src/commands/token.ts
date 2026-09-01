import { apiJson } from "../http.js";
import { confirm } from "../confirm.js";

type TokenRow = { id: string; name: string; token_prefix: string; scopes: string[]; revoked_at: string | null; created_at: string };

export async function token(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "create":
      return tokenCreate(rest);
    case "list":
      return tokenList(rest);
    case "revoke":
      return tokenRevoke(rest);
    default:
      throw new Error("Usage: ahood token create <name>|list [--json]|revoke <id> [--yes]");
  }
}

async function tokenCreate(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: ahood token create <name>");
  // Note: this itself requires an existing session-backed token or a
  // browser login -- per docs/adr/backend/0001-backend-services.md's Phase
  // 3 section, tokens can't mint tokens (POST /auth/tokens is session-only,
  // enforced server-side in Task 3). A CLI-only user with no browser access
  // at all cannot bootstrap their very first token through this command;
  // `ahood login`'s device-code flow is the only bootstrap path, which
  // is by design -- see the ADR's "login: device-code flow" as the sole
  // credential-issuing entry point for a CLI-only session.
  const result = await apiJson<{ token: string; name: string }>("/api/v1/auth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  console.log(`Created token "${result.name}": ${result.token}`);
  console.log("Copy this now -- it will not be shown again.");
}

async function tokenList(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const { tokens } = await apiJson<{ tokens: TokenRow[] }>("/api/v1/auth/tokens");

  if (jsonOutput) {
    console.log(JSON.stringify(tokens));
    return;
  }
  if (tokens.length === 0) {
    console.log("No tokens.");
    return;
  }
  for (const t of tokens) {
    console.log(`${t.id}  ${t.name}  ${t.token_prefix}...  ${t.scopes.join(",")}${t.revoked_at ? "  (revoked)" : ""}`);
  }
}

async function tokenRevoke(args: string[]): Promise<void> {
  const yes = args.includes("--yes");
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) throw new Error("Usage: ahood token revoke <id> [--yes]");

  // --yes bypasses both the lookup and the prompt entirely, preserving the
  // original one-shot behavior (a single DELETE call) for scripts/CI that
  // already call `ahood token revoke <id> --yes` unattended.
  if (!yes) {
    const confirmed = await confirm(`${await revokePrompt(id)} Type "yes" to confirm: `);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  await apiJson(`/api/v1/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  console.log(`Revoked ${id}`);
}

// Looks up the token's name/prefix via the same list endpoint tokenList
// uses, so the confirmation prompt shows something a human recognizes
// (e.g. `Revoke token "ci-runner" (ahd_ab...)?`) instead of a bare opaque
// UUID copied from `ahood token list` output -- easy to mistype with
// nothing to catch it. The lookup is best-effort: if it fails for any
// reason (network hiccup, the id not being present in the list, ...) this
// falls back to the bare id rather than blocking the revoke on a lookup
// that isn't itself the destructive operation.
async function revokePrompt(id: string): Promise<string> {
  try {
    const { tokens } = await apiJson<{ tokens: TokenRow[] }>("/api/v1/auth/tokens");
    const match = tokens.find((t) => t.id === id);
    if (match) return `Revoke token "${match.name}" (${match.token_prefix}...)?`;
  } catch {
    // Fall through to the bare-id form below.
  }
  return `Revoke token ${id}?`;
}
