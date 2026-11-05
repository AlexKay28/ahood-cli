// opencode (ahood#980). What was verified against opencode v2.1.2:
//   - MCP: `opencode mcp add ahood --url <u> --global` writes
//     `{"mcp": {"servers": {"ahood": {"type": "remote", "url": "<u>"}}}}` into
//     the first of opencode.json / opencode.jsonc that exists in the global
//     config dir (opencode.json when neither does), editing it with
//     jsonc-parser so comments survive. Setup does the same edit.
//   - Plugin (ahood#1009): setup lists @ahood/opencode-plugin in the config's
//     `plugins` array (plural: @opencode/schema 2.1.2 config.d.ts), and opencode
//     installs it from npm on its next start. The plugin brings the /ahood
//     commands and the opt-in snap hook (templates/opencode-plugin.ts); setup
//     keeps writing the MCP entry above, which the plugin defers to, so the
//     token policy is unchanged. A listed package opencode cannot install is
//     skipped silently (verified with v2.1.2: empty `plugin.list`, no error),
//     which is why `ahood doctor` checks npm has it.
//   Earlier opencode (v1) used a different MCP layout; setup refuses there.
import { AHOOD_COMMANDS, AHOOD_MCP_TOKEN_ENV, AHOOD_MCP_URL, type AhoodCommand } from "./ahood-commands.js";

export const OPENCODE_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;
export const OPENCODE_MCP_PATH = ["mcp", "servers", "ahood"] as const;
/** The config key opencode v2 lists plugins under. */
export const OPENCODE_PLUGINS_KEY = "plugins";

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

/**
 * One `/ahood` command's prompt: the shared body plus the user's arguments,
 * which opencode substitutes for $ARGUMENTS. The opencode plugin's commands
 * (templates/opencode-plugin.ts) send it.
 */
export function opencodeCommandTemplate(c: AhoodCommand): string {
  return [c.body, "", "User arguments, if any: $ARGUMENTS"].join("\n");
}
