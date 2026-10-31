// Claude Code (ahood#980): installed the native way, through the plugin
// marketplace in the public AlexKay28/ahood-cli repo (ahood#977), so updates
// use Claude Code's own plugin update flow.
//
// The marketplace is read from the `release` branch (ahood#1018 step B), not
// `main`. Verified against claude 2.1.282 in a throwaway HOME:
//   - `claude plugin marketplace add AlexKay28/ahood-cli#release` clones that
//     branch and declares it in ~/.claude/settings.json as
//     `extraKnownMarketplaces.ahood.source = { "source": "github", "repo":
//     "AlexKay28/ahood-cli", "ref": "release" }` (the `#<ref>` form the
//     host-marketplace docs give for a branch or tag).
//   - `add` with another ref than the one declared fails ("its network source
//     differs from the one declared for it in settings ... or change the
//     declaration"); with the declaration's `ref` edited first, `add` re-clones
//     at the new ref. That is how setup moves an existing install over.
//   - `marketplace remove ahood` deletes the whole declaration.
import { RELEASE_BRANCH, RELEASE_REPO } from "../release-channel.js";

export const CLAUDE_MARKETPLACE_REPO = RELEASE_REPO;
export const CLAUDE_MARKETPLACE_REF = RELEASE_BRANCH;
/** What `claude plugin marketplace add` takes: the repo at the release branch. */
export const CLAUDE_MARKETPLACE_SOURCE = `${CLAUDE_MARKETPLACE_REPO}#${CLAUDE_MARKETPLACE_REF}`;
/** `name` in .claude-plugin/marketplace.json, and so the `extraKnownMarketplaces` key in settings.json. */
export const CLAUDE_MARKETPLACE_NAME = "ahood";
export const CLAUDE_PLUGIN_ID = "ahood@ahood";

export const CLAUDE_INSTALL_ARGS = {
  marketplaceAdd: ["plugin", "marketplace", "add", CLAUDE_MARKETPLACE_SOURCE],
  pluginInstall: ["plugin", "install", CLAUDE_PLUGIN_ID],
  pluginUpdate: ["plugin", "update", CLAUDE_PLUGIN_ID],
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
