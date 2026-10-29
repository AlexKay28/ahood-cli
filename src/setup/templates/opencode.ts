// opencode (ahood#980). What was verified against opencode v2.1.2:
//   - MCP: `opencode mcp add ahood --url <u> --global` writes
//     `{"mcp": {"servers": {"ahood": {"type": "remote", "url": "<u>"}}}}` into
//     the first of opencode.json / opencode.jsonc that exists in the global
//     config dir (opencode.json when neither does), editing it with
//     jsonc-parser so comments survive. Setup does the same edit.
//   - Commands: opencode loads `{command,commands}/**/*.md` from the config
//     dir; front matter is the command's options (description, ...), the body
//     its template, $ARGUMENTS the user's arguments, and the file's path
//     (minus .md) its name -- so commands/ahood.md is `/ahood`.
//   Earlier opencode (v1) used a different MCP layout; setup refuses there.
//   - Opt-in snap hook (ahood#982, parity with the Claude Code plugin's Stop
//     hook): NOT ADDED. Verified against opencode v2.1.2 (`opencode --help`,
//     `opencode plugin --help`) and the plugin docs at opencode.ai/docs/plugins
//     (2026-10-29): opencode plugins are npm modules installed with
//     `opencode plugin <module> [-g]`, not files setup can drop into a config
//     dir, and their session-lifecycle hooks (`session.idle`, `session.deleted`,
//     ...) are reactive event listeners -- none of them can return a decision
//     that blocks/continues the session the way Claude Code's Stop hook
//     ({"decision":"block","reason":...}) does. Without that, a snap reminder
//     here could only print a message after the session has already ended,
//     which is not the same feature. Revisit if opencode adds a decision-
//     gating session-end hook.
import { OWNED_MARKER } from "../file-changes.js";
import { AHOOD_COMMANDS, AHOOD_MCP_TOKEN_ENV, AHOOD_MCP_URL } from "./ahood-commands.js";

export const OPENCODE_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;
export const OPENCODE_MCP_PATH = ["mcp", "servers", "ahood"] as const;

// `headers` is what `opencode mcp add --header` writes; `{env:NAME}` is
// opencode's config substitution, so by default the file names the token. With
// the user's consent (ahood#990) the header holds the token itself -- exactly
// what `opencode mcp add ahood --url <u> --header "Authorization=Bearer <t>"
// --global` writes (verified against opencode v2.1.2). The entry is ours by its
// url, so `ahood setup --remove opencode` takes the token out with it.
export function opencodeMcpEntry(token: string | null = null): { type: "remote"; url: string; headers: Record<string, string> } {
  return { type: "remote", url: AHOOD_MCP_URL, headers: { Authorization: `Bearer ${token ?? `{env:${AHOOD_MCP_TOKEN_ENV}}`}` } };
}

/** The token an entry's Authorization header holds literally (not an `{env:...}` reference), if any. */
export function opencodeStoredToken(entry: unknown): string | null {
  const auth = (entry as { headers?: { Authorization?: unknown } } | null | undefined)?.headers?.Authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  const value = auth.slice("Bearer ".length);
  return value === "" || value.startsWith("{env:") ? null : value;
}

export function opencodeCommandFiles(): Array<{ file: string; content: string }> {
  return AHOOD_COMMANDS.map((c) => ({
    file: `${c.name}.md`,
    content: [
      "---",
      `description: ${JSON.stringify(c.description)}`,
      "---",
      "",
      c.body,
      "",
      "User arguments, if any: $ARGUMENTS",
      "",
      // The marker sits in the template body, not the front matter: opencode
      // validates front matter against its command schema and skips a command
      // that fails it, so an extra key there is a risk not worth taking.
      `<!-- ${OWNED_MARKER}; remove with \`ahood setup --remove opencode\` -->`,
      "",
    ].join("\n"),
  }));
}
