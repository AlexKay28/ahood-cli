import { apiJson } from "../http.js";

type TokenRow = { id: string; name: string; token_prefix: string; scopes: string[]; revoked_at: string | null; created_at: string };

export async function token(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "create":
      return tokenCreate(rest);
    case "list":
      return tokenList();
    case "revoke":
      return tokenRevoke(rest);
    default:
      throw new Error("Usage: skillhub token create|list|revoke");
  }
}

async function tokenCreate(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("Usage: skillhub token create <name>");
  // Note: this itself requires an existing session-backed token or a
  // browser login -- per docs/adr/backend/0001-backend-services.md's Phase
  // 3 section, tokens can't mint tokens (POST /auth/tokens is session-only,
  // enforced server-side in Task 3). A CLI-only user with no browser access
  // at all cannot bootstrap their very first token through this command;
  // `skillhub login`'s device-code flow is the only bootstrap path, which
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

async function tokenList(): Promise<void> {
  const { tokens } = await apiJson<{ tokens: TokenRow[] }>("/api/v1/auth/tokens");
  if (tokens.length === 0) {
    console.log("No tokens.");
    return;
  }
  for (const t of tokens) {
    console.log(`${t.id}  ${t.name}  ${t.token_prefix}…  ${t.scopes.join(",")}${t.revoked_at ? "  (revoked)" : ""}`);
  }
}

async function tokenRevoke(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("Usage: skillhub token revoke <id>");
  await apiJson(`/api/v1/auth/tokens/${id}`, { method: "DELETE" });
  console.log(`Revoked ${id}`);
}
