// Claude Code (ahood#980): installed the native way, through the plugin
// marketplace in the public AlexKay28/ahood-cli repo (ahood#977), so updates
// use Claude Code's own plugin update flow. Setup writes no files for it.

export const CLAUDE_MARKETPLACE_SOURCE = "AlexKay28/ahood-cli";
/** `name` in .claude-plugin/marketplace.json. */
export const CLAUDE_MARKETPLACE_NAME = "ahood";
export const CLAUDE_PLUGIN_ID = "ahood@ahood";

export const CLAUDE_INSTALL_ARGS = {
  marketplaceAdd: ["plugin", "marketplace", "add", CLAUDE_MARKETPLACE_SOURCE],
  pluginInstall: ["plugin", "install", CLAUDE_PLUGIN_ID],
} as const;

export const CLAUDE_REMOVE_ARGS = {
  pluginUninstall: ["plugin", "uninstall", CLAUDE_PLUGIN_ID],
  marketplaceRemove: ["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE_NAME],
} as const;

/** For a claude CLI without `plugin` subcommands: the same steps typed inside a session. */
export const CLAUDE_IN_SESSION_INSTALL = [`/plugin marketplace add ${CLAUDE_MARKETPLACE_SOURCE}`, `/plugin install ${CLAUDE_PLUGIN_ID}`];
export const CLAUDE_IN_SESSION_REMOVE = [`/plugin uninstall ${CLAUDE_PLUGIN_ID}`, `/plugin marketplace remove ${CLAUDE_MARKETPLACE_NAME}`];

// The plugin's .mcp.json can only name an env var (`Bearer ${AHOOD_TOKEN}`),
// and Claude Code has no working fallback between two names: verified against
// Claude Code 2.1.282 with a header-capturing local server --
// `${AHOOD_TOKEN:-${AHOOD_API_TOKEN}}` sends "Bearer <token>}" (a stray brace)
// whenever AHOOD_TOKEN is set, because the default ends at the first "}".
// What does work: the `env` map in ~/.claude/settings.json feeds that
// expansion (same verification). So with the user's consent (ahood#990,
// decision B) setup stores the token there, beside a marker key so
// `ahood setup --remove claude` deletes only a token setup itself wrote.
export const CLAUDE_TOKEN_ENV_KEY = "AHOOD_TOKEN";
export const CLAUDE_TOKEN_MARKER_KEY = "AHOOD_TOKEN_SET_BY";
export const CLAUDE_TOKEN_MARKER_VALUE = "ahood setup (remove with `ahood setup --remove claude`)";
