# ahood

ahood in Claude Code. The plugin connects a session to [ahood](https://www.ahood.dev)'s MCP
server, so an agent can search, fetch, read and publish skills, agents, MCP servers and docs
(the 20+ tools documented at [ahood.dev/docs#mcp](https://www.ahood.dev/docs#mcp)). It also adds
`/ahood` commands for your dashboard, syncing updates, reviewing evolution proposals and
capturing private snaps.

This plugin is published from the [`AlexKay28/ahood-cli`](https://github.com/AlexKay28/ahood-cli)
marketplace. Install it with:

```
/plugin marketplace add AlexKay28/ahood-cli
/plugin install ahood@ahood
```

or run `ahood setup claude` in a terminal. Claude Code's own update flow
(`claude plugin update ahood@ahood`) picks up new versions.

## Setup

1. Mint a personal access token at [ahood.dev/settings/tokens](https://www.ahood.dev/settings/tokens).
2. Set it as `AHOOD_API_TOKEN` in your environment (e.g. in your shell profile, or wherever
   you keep secrets for Claude Code).
3. Install this plugin. Claude Code will connect to `https://www.ahood.dev/api/mcp` using
   that token.
4. For the `/ahood` commands, install the CLI (`npm i -g @ahood/cli`) and run `ahood login`
   once (or set `AHOOD_TOKEN` for headless use). Without a global install the commands fall
   back to `npx -y @ahood/cli`.

A token is required for every tool, including read-only ones (`search_skills`, `get_skill`,
etc.) -- a request to `https://www.ahood.dev/api/mcp` with no token is rejected outright. A
missing or invalid token will also reject the authoring tools (`create_skill`, `update_skill`,
and friends), which additionally require the `publish` scope. The plugin files hold no
secrets: `.mcp.json` names the `AHOOD_API_TOKEN` variable, never a token.

## Commands

| Type | Does |
| --- | --- |
| `/ahood` | Dashboard: runs `ahood status --json` and summarises installed vs latest versions, pins, pending evolution proposals, and whether evolution is on |
| `/ahood sync` or `/ahood-sync` | Runs `ahood sync --dry-run --json`, shows a diff per update, and applies only the updates you approve (`ahood sync <owner>/<slug> --yes`). Never silent |
| `/ahood review` or `/ahood-review` | Runs `ahood review --json`, shows each proposal with its evidence, and approves or rejects (`ahood review approve\|reject <id>`) only on your decision |
| `/ahood snap` or `/ahood-snap` | Drafts a structured snap of the session (summary, failed, worked, fix, lesson, artifact), shows it, and saves it with `ahood snap create` only if you say yes |

Each is also reachable namespaced (`/ahood:ahood`, `/ahood:ahood-sync`, ...) when another plugin
uses the bare name. You start these commands; Claude does not invoke them on its own
(`disable-model-invocation`).

**What is pre-approved.** Each command's `allowed-tools` lists only the read-only calls it starts
with: `ahood status --json`, `ahood sync --dry-run --json`, `ahood skill diff ...` and
`ahood review --json`. Everything that changes state (syncing, approving, rejecting, pinning,
saving a snap) is left out on purpose, so after you agree in chat Claude Code still asks its own
permission before running it.

Snaps are private to you: only you can read them, unless you create a share link. They feed
automatic evolution only for artifacts you have enabled after giving consent, and they are
deleted automatically about 3 days after creation.

## For maintainers

`commands/*.md` are generated from `src/setup/templates/ahood-commands.ts`, the same source the
Codex and opencode setup renders, by `npm run sync-plugin`; `tests/claude-plugin.test.ts` fails
when they drift. Bump `version` in `.claude-plugin/plugin.json` and the marketplace entry together
on every change: a set `version` keeps users on it until it changes.
