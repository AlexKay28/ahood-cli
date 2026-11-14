# Changelog

What changed in the ahood Claude Code plugin, one section per release. The plugin's version is
the CLI's (`@ahood/cli`), so every section matches a `v<version>` tag of
[AlexKay28/ahood-cli](https://github.com/AlexKay28/ahood-cli/releases). Claude Code's "Plugin
updated" notice points here.

Releasing: add the `## <version>` section here and commit it **before** `npm version`. Its
`preversion` hook (and the release workflow) refuse a version without one
(`scripts/check-changelog.mjs`).

## 0.18.0 (2026-11-14)

- `ahood login` stops at the first real error from the server (for example "too many active
  tokens", or a server error) and prints it. Before, it waited about 10 minutes and then said
  "Login timed out".
- CLI logins now expire after 90 days. An expired or revoked login gets a clear message:
  "Your ahood login has expired or was revoked. Run `ahood login` again." If the rejected token
  came from `AHOOD_TOKEN`, the message says so instead.
- `ahood login` sends the server's one-time device code on every poll, in a header (never in
  the URL), so only the terminal that started a login can complete it.
- Lockfile entries record the skill's id. `ahood status` and `ahood sync` refuse an entry
  whose `owner/slug` now points at a different skill, and follow an owner rename to the new
  name.

## 0.17.0 (2026-11-10)

- `ahood publish` on an artifact that already exists now applies `--tagline`, `--tags`,
  `--license`, `--homepage` and `--repository` (they used to be applied only on the first
  publish). `--name` still only applies when creating.
- Account links point at the web app's new `/workspace/...` pages (tokens, evolution
  dashboard, group invite links). Old links keep working through the site's redirects.
- Updates come from the `release` branch: Claude Code and Codex now read the plugin from
  `AlexKay28/ahood-cli#release`, which each published release fast-forwards, so unreleased
  commits never reach you and every release does (opencode gets its plugin from npm,
  `@ahood/opencode-plugin`, which only a release publishes). Re-run
  `npx @ahood/cli@latest setup` once to move an existing install onto it.
- Claude Code: `ahood setup claude` asks once whether to keep ahood up to date automatically
  (default yes; `--no-auto-update` to skip). `ahood doctor` shows the channel and auto-update
  state for each host.
- Removed the local stdio MCP server (`ahood mcp serve`) and `ahood help useme`: ahood is a
  plugin now, and its MCP server and skill come with it. Both commands print a one-line notice
  for this release. The `ahood mcp` registry commands (search, add, publish MCP manifests) stay.
- The plugin manifest is validated (`claude plugin validate --strict`) before every release.

## 0.16.0 (2026-10-31)

- The full `/ahood` command set: `/ahood-find`, `/ahood-trending`, `/ahood-try`, `/ahood-install`,
  `/ahood-prompt`, `/ahood-loop`, `/ahood-project`, `/ahood-star`, `/ahood-publish`, `/ahood-stats`,
  as well as `/ahood-sync`, `/ahood-review` (now with unified diffs) and `/ahood-snap`.
- The commands run `npx -y @ahood/cli@<plugin version>`, the CLI the plugin shipped with, not
  whatever `ahood` is on PATH.
- One generated version: the plugin is now versioned with the CLI (it was 2.0.2), so this
  release reaches every installed copy as an update.

## 0.15.0 (2026-10-31)

- Plugin 2.0.2: `/ahood`, `/ahood-sync`, `/ahood-review` and `/ahood-snap`, and the hosted MCP
  server, which reads only `AHOOD_TOKEN` (since 2.0.1; it used to be `AHOOD_API_TOKEN`).
- The same commands now ship for Codex (`plugins/codex`) and opencode (`@ahood/opencode-plugin`).
