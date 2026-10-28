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
