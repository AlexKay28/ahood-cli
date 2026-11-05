# Changelog

What changed in the ahood Claude Code plugin, one section per release. The plugin's version is
the CLI's (`@ahood/cli`), so every section matches a `v<version>` tag of
[AlexKay28/ahood-cli](https://github.com/AlexKay28/ahood-cli/releases). Claude Code's "Plugin
updated" notice points here.

Releasing: add the `## <version>` section here and commit it **before** `npm version`. Its
`preversion` hook (and the release workflow) refuse a version without one
(`scripts/check-changelog.mjs`).

## 0.18.0

- Removed the forms deprecated in ahood#990 (ahood#995):
  - `ahood skill update` and `ahood skill outdated`: use `ahood sync` and `ahood status`, which
    cover every project on the machine. `ahood agent|mcp|doc|project|loop update`/`outdated` stay.
  - `ahood skill publish <path> --owner <owner> --slug <skill> --version <x.y.z>`: use
    `ahood skill publish <owner>/<skill>@<version> [--path <dir>]`. The old flags are refused.
  - `AHOOD_API_TOKEN`: the CLI no longer reads it. Use `AHOOD_TOKEN` (or `ahood setup --store-token`).
- The one-line notices for `ahood mcp serve` and `ahood help useme` are gone. Bare `ahood mcp`
  now prints the mcp command list, like every other noun.
- `ahood setup` and `ahood doctor` no longer clean up or flag what setup wrote before the plugin
  (`$CODEX_HOME/skills/ahood/SKILL.md`, the AGENTS.md snippet, opencode's `commands/ahood*.md`).
  Delete those by hand if you still have them.

## 0.17.0

- Updates come from the `release` branch: every host now reads the plugin from
  `AlexKay28/ahood-cli#release`, which each published release fast-forwards, so unreleased
  commits never reach you and every release does. Re-run `npx @ahood/cli@latest setup` once to
  move an existing install onto it.
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
