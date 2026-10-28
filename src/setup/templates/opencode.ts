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
import { OWNED_MARKER } from "../file-changes.js";
import { AHOOD_COMMANDS, AHOOD_MCP_TOKEN_ENV, AHOOD_MCP_URL } from "./ahood-commands.js";

export const OPENCODE_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;
export const OPENCODE_MCP_PATH = ["mcp", "servers", "ahood"] as const;

// `headers` is what `opencode mcp add --header` writes; `{env:NAME}` is
// opencode's config substitution, so the file names the token, never holds it.
export function opencodeMcpEntry(): { type: "remote"; url: string; headers: Record<string, string> } {
  return { type: "remote", url: AHOOD_MCP_URL, headers: { Authorization: `Bearer {env:${AHOOD_MCP_TOKEN_ENV}}` } };
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
