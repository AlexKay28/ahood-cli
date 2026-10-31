# ahood

ahood in Claude Code. The plugin connects a session to [ahood](https://www.ahood.dev)'s MCP
server, so an agent can search, fetch, read and publish skills, agents, MCP servers and docs
(the 20+ tools documented at [ahood.dev/docs#mcp](https://www.ahood.dev/docs#mcp)). It also adds
`/ahood` commands to find, try and install artifacts, use prompts and loops, publish, star, see
your stats, sync updates, review evolution proposals and capture private snaps.

This plugin is published from the [`AlexKay28/ahood-cli`](https://github.com/AlexKay28/ahood-cli)
marketplace. Install it with:

```
/plugin marketplace add AlexKay28/ahood-cli
/plugin install ahood@ahood
```

or run `ahood setup claude` in a terminal. Claude Code's own update flow
(`claude plugin update ahood@ahood`) picks up new versions.

## Setup

The easy way: run `npx @ahood/cli@latest setup claude` in a terminal. It logs you in, installs this
plugin and, if you say yes, stores your token as `env.AHOOD_TOKEN` in `~/.claude/settings.json`.
By hand:

1. Mint a personal access token at [ahood.dev/settings/tokens](https://www.ahood.dev/settings/tokens).
2. Set it as `AHOOD_TOKEN` in your environment (e.g. in your shell profile, or `env` in
   `~/.claude/settings.json`). **Renamed in 2.0.1:** earlier versions read `AHOOD_API_TOKEN`;
   rename it -- Claude Code has no fallback between two variable names.
3. Install this plugin. Claude Code will connect to `https://www.ahood.dev/api/mcp` using
   that token.
4. For the `/ahood` commands, install the CLI (`npm i -g @ahood/cli`) and run `ahood login`
   once (or set `AHOOD_TOKEN` for headless use). Without a global install the commands fall
   back to `npx -y @ahood/cli`.

A token is required for every tool, including read-only ones (`search_skills`, `get_skill`,
etc.) -- a request to `https://www.ahood.dev/api/mcp` with no token is rejected outright. A
missing or invalid token will also reject the authoring tools (`create_skill`, `update_skill`,
and friends), which additionally require the `publish` scope. The plugin files hold no
secrets: `.mcp.json` names the `AHOOD_TOKEN` variable, never a token.

## Commands

| Type | Does |
| --- | --- |
| `/ahood` | Hub: `ahood status --json` as a table (installed vs latest, pins, pending proposals, evolution on/off), a menu of every command below, and one suggested next action |
| `/ahood-find <need> [--kind <kind>]` | `ahood find --json`: the top 5 matches with kind, purpose, stars and downloads, and why each fits; offers try or install |
| `/ahood-trending [--kind <kind>]` | `ahood find --sort downloads`: the most installed artifacts |
| `/ahood-try <owner/slug>` | `ahood try`: reads the artifact's root document into the session for this task, installs nothing |
| `/ahood-install <owner/slug>` | Previews it (`ahood skill view`, `ahood try`: version, contents, risks, where it writes), then runs `ahood <kind> add` only after your yes |
| `/ahood-prompt <owner/slug>` | Asks for each declared input, fills the prompt with `ahood prompt get`, shows it, and uses it once |
| `/ahood-loop <owner/slug>` | Loads a loop's rules (`ahood try`) and, after your yes, follows them for this session |
| `/ahood-project` | `ahood project --json`: this repository's project guide from ahood, or an offer to write and publish one |
| `/ahood-star <owner/slug>` | Stars it with `ahood skill star` after your yes |
| `/ahood-publish` | Finds the artifact in this directory by its root file, shows the diff against the published version, and runs `ahood skill publish` only after your yes |
| `/ahood-stats` | `ahood stats --json`: your artifacts' downloads and stars, totals, recent activity and evolution counts |
| `/ahood-sync` | `ahood sync --dry-run`, a diff per update, then `ahood sync <owner>/<slug> --yes` only for the updates you approve in chat |
| `/ahood-review` | `ahood review --json`, each proposal with its unified diff and evidence, then `ahood review approve\|reject <id>` only on your decision |
| `/ahood-snap` | Drafts a structured, private snap of the session, shows it, and runs `ahood snap create ...` only if you say yes |

Each is also reachable namespaced (`/ahood:ahood`, `/ahood:ahood-sync`, ...) when another plugin
uses the bare name. You start these commands; Claude does not invoke them on its own
(`disable-model-invocation`).

**What is pre-approved.** Each command's `allowed-tools` lists only the read-only calls it starts
with: `ahood status --json`, `ahood find ...`, `ahood try ...`, `ahood skill view ...`,
`ahood prompt read|get ...`, `ahood project --json`, `ahood stats --json`, `ahood sync --dry-run --json`,
`ahood skill diff ...`, `ahood review --json` and `ahood review show ...`. Everything that changes state
(installing, starring, publishing, syncing, approving, rejecting, pinning, saving a snap) is left out on purpose, so after you agree in chat Claude Code still asks its own
permission before running it.

Snaps are private to you: only you can read them, unless you create a share link. They feed
automatic evolution only for artifacts you have enabled after giving consent, and they are
deleted automatically about 3 days after creation.

## For maintainers

`commands/*.md` are generated from `src/setup/templates/ahood-commands.ts`, the same source the
Codex and opencode setup renders, by `npm run sync-plugin`; `tests/claude-plugin.test.ts` fails
when they drift. So is `.claude-plugin/plugin.json`, whose `version` is the CLI's (never bump it by
hand; the marketplace entry sets none): a set `version` keeps users on it until it changes, and the
commands run `npx -y @ahood/cli@<that version>`.

## Optional: snap prompt at the end of a task

The plugin ships an **opt-in** Stop hook (`hooks/snap-prompt.mjs`). It is **off by default**. When you turn it on, at most once per session, after Claude finishes, it asks Claude to draft a private ahood snap of what the session learned and to **ask you before saving**. The hook itself never sends anything: it has no network access and never runs the `ahood` CLI. Saving is a separate step that you agree to.

Turn it on by setting `AHOOD_SNAP_HOOK=1` in the environment Claude Code runs in, for example in your shell profile or in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "AHOOD_SNAP_HOOK": "1" } }
```

To turn it off, remove the variable or set it to anything other than `1`.
