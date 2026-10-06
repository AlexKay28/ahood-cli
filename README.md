# ahood

**The command-line client for [ahood](https://ahood.vercel.app) — a registry for installing and publishing [Claude Code](https://claude.com/claude-code) Skills.**

[![npm version](https://img.shields.io/npm/v/@ahood/cli.svg?color=blue)](https://www.npmjs.com/package/@ahood/cli)
[![npm downloads](https://img.shields.io/npm/dm/@ahood/cli.svg)](https://www.npmjs.com/package/@ahood/cli)
[![CI](https://github.com/AlexKay28/ahood-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexKay28/ahood-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@ahood/cli.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@ahood/cli.svg)](package.json)

`ahood` is `npm` for Claude Code Skills: publish a skill folder to the registry with one command, install anyone else's with another, and pin exact versions in a lockfile so a team (or a fleet of agents) all run the same thing. It's built to be driven by humans and AI agents equally — every command has a `--json` mode, exit codes are stable and documented, and the whole thing works headlessly with a single environment variable.

```
$ ahood skill search pdf
alice/pdf-tools        Merge, split, and compress PDFs from the command line
bob/pdf-form-filler     Fill PDF form fields from a JSON or CSV data source

$ ahood skill add alice/pdf-tools
Installed alice/pdf-tools@1.4.0 to .claude/skills/alice@pdf-tools
```

---

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [Why ahood](#why-ahood)
- [Configuration](#configuration)
- [Usage examples](#usage-examples)
- [Kinds: skills, agents, and MCP servers](#kinds-skills-agents-and-mcp-servers)
- [Commands](#commands)
- [Exit codes](#exit-codes)
- [Compatibility](#compatibility)
- [Shell completion](#shell-completion)
- [Using ahood from an AI agent](#using-ahood-from-an-ai-agent)
- [Development](#development)
- [License](#license)

## Quick start

```
npx @ahood/cli@latest login
npx @ahood/cli@latest skill search <something>
npx @ahood/cli@latest skill add <owner>/<skill>
```

That's it — `login` opens a device-code flow in your browser and stores a token locally; every command after that just works.

## Install

Run it on demand with `npx`, no install step required:

```
npx @ahood/cli@latest <command>
```

Or install it globally so the plain `ahood` command works everywhere:

```
npm i -g @ahood/cli
ahood <command>
```

**The `-g` flag matters.** `npm i @ahood/cli` (no `-g`) installs into the current directory's `node_modules/` instead, and `ahood` won't be on your `PATH` -- you'll get `ahood: command not found`. If that happens, either re-run with `-g`, or use `npx @ahood/cli@latest <command>` from that directory instead.

Requires Node.js 18 or later.

## Why ahood

- **One command to publish, one to install.** `ahood skill publish owner/skill@1.0.0 --path ./my-skill` uploads a folder containing a `SKILL.md`; `ahood skill add owner/skill` installs it into `.claude/skills/`. No registry account setup beyond `ahood login`.
- **Real versioning, not just a snapshot.** Every publish is a semver version with its own changelog (`ahood skill versions`), and installs are pinned by checksum in a lockfile (`.claude/skills.lock.json`) so `ahood skill update` only ever moves forward on purpose.
- **Mistakes are recoverable.** Published the wrong version? `ahood skill unpublish owner/skill@1.2.3` yanks just that one — existing installs keep working, new ones are warned off it — without deleting the skill's whole history.
- **Public or private, your call.** `ahood skill edit owner/skill --visibility private` scopes a skill to just you; `ahood skill list` shows both.
- **Scriptable by design.** Every read command and most write commands support `--json`; `ahood skill publish --json` emits a single structured result object instead of progress text, and exit codes (below) are stable enough to branch on in a script.
- **Headless-first.** Set `AHOOD_TOKEN` and skip `login` entirely — every command checks it first, which is what CI pipelines and AI agents both actually want.

## Configuration

| Variable | Purpose |
| --- | --- |
| `AHOOD_TOKEN` | A personal API token (create one with `ahood token create <name>` after logging in once). When set, every command uses it instead of the stored browser-login credentials — the standard way to authenticate in CI or any non-interactive environment. |
| `AHOOD_API_URL` | Overrides the registry endpoint (default: `https://ahood.vercel.app`). Must be `https://`, except for `localhost`/`127.0.0.1` or a `.test`/`.invalid`/`.example`/`.localhost` host, which may use plain `http://` for local development. |
| `XDG_CONFIG_HOME` | If set, browser-login credentials are stored under `$XDG_CONFIG_HOME/ahood/credentials.json` instead of the default `~/.config/ahood/credentials.json`. |

Paths `ahood` reads and writes in your project. The lockfile is meant to be committed, same as `package-lock.json`:

| Path | What's in it |
| --- | --- |
| `.claude/skills/<owner>@<skill>/` | Installed skill files. |
| `.claude/agents/<owner>@<skill>.md` | An installed agent, as a single file (`@` owner/skill separator, since Claude Code's own subagent loader scans `.claude/agents/*.md` flat, non-recursively). |
| `.claude/skills.lock.json` | Exact installed version + checksum per skill or agent, written by `add`/`update`, read by every install to verify integrity. |
| `.mcp.json` | MCP server entries, for `mcp`-kind artifacts only. Merged into rather than owned — other MCP clients share this file. **May contain secrets in plaintext**, since a server manifest can declare credentials that `add` prompts for; `add` warns when it writes one. |
| `*.json.tmp-<pid>-<hrtime>` | Never, in normal operation. Writes to the two `.json` files above go through a temp file that is renamed into place, and only a hard kill (SIGKILL, OOM, power loss) mid-write can strand one. A stranded copy of `.mcp.json` carries the same plaintext secrets, so **gitignore this pattern**. The next successful write removes any left by a process that is no longer running. |

## Usage examples

<details>
<summary><strong>Search, inspect, then install</strong></summary>

```
$ ahood skill search pdf --json | jq '.[0]'
{"slug": "pdf-tools", "owner": "alice", "tagline": "Merge, split, and compress PDFs", ...}

$ ahood skill view alice/pdf-tools
alice/pdf-tools
  name:        PDF Tools
  tagline:     Merge, split, and compress PDFs from the command line
  license:     MIT
  version:     1.4.0
  ...

$ ahood skill read alice/pdf-tools
---
name: pdf-tools
description: Merge, split, and compress PDFs from the command line
---

# PDF Tools
...

$ ahood skill add alice/pdf-tools@1.4.0
Installed alice/pdf-tools@1.4.0 to .claude/skills/alice@pdf-tools
```
</details>

<details>
<summary><strong>Scaffold and publish a new skill</strong></summary>

```
$ ahood skill init my-skill
Created ./my-skill/SKILL.md

$ ahood skill publish alice/my-skill@1.0.0 --path my-skill --name "My Skill" --tagline "Does a thing"
Created alice/my-skill -- publishing its first version now.
Uploaded alice/my-skill@1.0.0 -- processing...
Published alice/my-skill@1.0.0 (published)
```
</details>

<details>
<summary><strong>Preview and apply updates safely</strong></summary>

```
$ ahood skill update --dry-run
SKILL                 CURRENT  LATEST  STATUS
alice/pdf-tools        1.4.0    1.5.0   update available
bob/pdf-form-filler     2.0.0    2.0.0   up to date

$ ahood skill update
Updated alice/pdf-tools to 1.5.0.
```
</details>

<details>
<summary><strong>Yank a bad publish without deleting everything</strong></summary>

```
$ ahood skill unpublish alice/pdf-tools@1.5.0 --yes
Yanked alice/pdf-tools@1.5.0. Existing lockfile pins still resolve; new installs will be warned off it.
```
</details>

<details>
<summary><strong>CI / non-interactive use</strong></summary>

```
export AHOOD_TOKEN=ahd_your_token_here
ahood skill publish alice/pdf-tools@1.5.1 --path ./pdf-tools --json
```
</details>

<details>
<summary><strong>Create a private group and share a skill with it</strong></summary>

```
$ ahood group create "Design Team" --description "Shared skills for the design team"
Created group Design Team (design-team).

$ ahood group invite-link design-team
https://ahood.vercel.app/groups/join?token=abc123...
Expires: 2026-09-14T00:00:00.000Z
This link (and its token) is shown only this once -- save it now, it cannot be retrieved again.

$ ahood skill share alice/pdf-tools --group design-team
Shared alice/pdf-tools with design-team.
```

Sharing is additive -- it doesn't change `alice/pdf-tools`'s own public/private visibility, it just makes it visible to everyone in `design-team` too. On the other side, whoever received the link runs `ahood group join <the link>` to join.
</details>

## Kinds: skills, agents, and MCP servers

The registry holds three kinds of artifact this CLI works with, each with its own command group. All three take the same verbs (`search`, `list`, `view`/`show`, `read`, `versions`, `diff`, `add`, `update`, `outdated`, `remove`, `edit`, `unpublish`, `star`, `unstar`, `share`, `unshare`, `init`, `publish`), run by the same code:

| Kind | Root file | `add` installs to | Group |
| --- | --- | --- | --- |
| skill | `SKILL.md` | `.claude/skills/<owner>@<skill>/` | `ahood skill <verb>` |
| agent | `AGENT.md` | `.claude/agents/<owner>@<agent>.md` | `ahood agent <verb>` |
| mcp | `server.json` | an entry merged into `.mcp.json` | `ahood mcp <verb>` |

```
$ ahood agent search review
$ ahood agent init code-reviewer        # ./code-reviewer/AGENT.md
$ ahood agent publish alice/code-reviewer@1.0.0 --path code-reviewer --name "Code Reviewer"
$ ahood mcp init github-server          # ./github-server/server.json, a safe placeholder starter
$ ahood mcp add alice/github-server
$ ahood agent add alice/pdf-tools
alice/pdf-tools is a skill, not an agent -- refusing to install it. Use `ahood skill add alice/pdf-tools` instead.
```

- **`ahood agent` and `ahood mcp` are strict.** A target of another kind is refused -- exit code `2`, naming the kind it found -- before anything is downloaded, prompted for, written, or sent. That covers `add`, `update`, `remove`, `edit`, `unpublish`, `share`/`unshare`, `star`/`unstar`, and `publish` (an existing entry of another kind is refused before anything is packed or uploaded); the read-only verbs refuse too, rather than show the wrong kind. `search` asks the registry for that kind only, `list` keeps only that kind of your own entries, and `update`/`outdated` with no argument consider only installed pins of that kind. `agent publish`/`mcp publish` imply their kind and reject a contradictory `--kind`.
- **Missing or unexpected kind metadata is refused, never guessed.** If the registry's answer carries no kind (or one this CLI doesn't handle), a kind-scoped command stops with exit `1` and points at the legacy form. `remove` reads the kind from the project's own files (the skill directory, the agent file, or the mcp fingerprint in the lockfile) and asks the registry only when those can't tell; if neither can, nothing is removed.
- **`ahood skill` is legacy and cross-kind in this release.** `ahood skill search` and `ahood skill list` include every kind, and `ahood skill add`/`update`/`remove`/... act on whatever kind the target is, exactly as before -- including `--json` output and exit codes -- so existing scripts keep working. Add `--kind skill|agent|mcp` to any `ahood skill` verb (except `publish`, whose `--kind` keeps its original meaning) to scope it, or `--kind all` to spell out the cross-kind behavior.
- **Not in scope: `doc`.** The registry also has a `doc` kind (documentation pages); this CLI has no `ahood doc` group. Kind dispatch is table-driven (`src/kind-info.ts`), so adding one is an entry there plus its help and `init` template.

**Migration plan for a strict `ahood skill`.** A future major version will make `ahood skill <verb>` skills-only by default, matching `agent` and `mcp`. Until then: (1) this release adds the strict groups and `--kind`, and labels `ahood skill` as legacy in `--help`; (2) a following minor release prints a stderr deprecation note when an `ahood skill` command actually touches a non-skill entry (stdout and `--json` unchanged); (3) the major release flips the default, keeping `ahood skill <verb> --kind all` as the explicit cross-kind escape hatch. Scripts that want today's behavior forever can pass `--kind all` now.

**`ahood mcp` has two meanings.** With no arguments, or as `ahood mcp serve` (the preferred spelling), it starts this CLI's local, read-only MCP server over stdio -- unchanged, so existing MCP host configurations keep working with no edits. With a registry verb it manages MCP server manifests. Anything else (`ahood mcp srve`, `ahood mcp --flag`) fails with usage and a suggestion instead of starting a server. Neither is the hosted registry MCP endpoint at `https://ahood.vercel.app/api/mcp`.

## Commands

<!-- Generated from src/help.ts's COMMANDS_HELP by scripts/sync-readme.mjs --
     do not hand-edit the table below. Run `npm run sync-readme` after
     changing COMMANDS_HELP to regenerate it. -->

<!-- COMMANDS_TABLE_START -->
### Account

| Command | What it does |
| --- | --- |
| `ahood login` | Device-code browser login, stores a token locally. |
| `ahood logout` | Removes the stored token. |
| `ahood whoami [--json]` | Reports whether your stored token still authenticates. |
| `ahood token create <name>\|list [--json]\|revoke <id> [--yes]` | Manage personal API tokens. |
| `ahood completion <bash\|zsh\|fish>` | Print a shell completion script for the command names. |
| `ahood help useme` | Print the bundled ahood SKILL.md for an AI agent -- raw, offline, no login needed. |

### Skill (legacy, cross-kind)

| Command | What it does |
| --- | --- |
| `ahood skill search <query> [--json] [--limit <n>]` | Search published skills. |
| `ahood skill view\|show <owner>/<skill> [--json] [--web]` | Show a single skill's details -- tags, license, homepage, repository, dates, and more -- without installing it (alias: ahood skill show). |
| `ahood skill read <owner>/<skill> [--json]` | Print a skill's full SKILL.md content, without installing it. |
| `ahood skill versions <owner>/<skill> [--json]` | List a skill's published-version history -- version, changelog, size, and publish date. |
| `ahood skill diff <owner>/<skill> <versionA> <versionB> [--json]` | Show what changed between two published versions -- a SKILL.md diff plus an added/removed/changed file summary. |
| `ahood skill list [--json]` | List your own skills, public and private. |
| `ahood skill add <owner>/<skill>[@version]` | Install a skill into .claude/skills/, pinned in the lockfile. |
| `ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]` | Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once. |
| `ahood skill outdated [<owner>/<skill> ...] [--json]` | Read-only staleness check comparing current and latest versions (with changelog) for installed skills. |
| `ahood skill remove <owner>/<skill> [--yes]` | Uninstall and unpin a skill (local only, prompts for confirmation unless --yes is passed). |
| `ahood skill edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]` | Update a skill you own, changing only the flags you pass. |
| `ahood skill unpublish <owner>/<skill>[@version] [--yes]` | Delete a skill from the registry for every consumer, or yank a single version, not just your local install (prompts for confirmation unless --yes is passed). |
| `ahood skill star <owner>/<skill>` | Star a skill. |
| `ahood skill unstar <owner>/<skill>` | Remove your star from a skill. |
| `ahood skill share <owner>/<skill> --group <group>` | Share a skill you own with a group, without changing its public/private visibility. |
| `ahood skill unshare <owner>/<skill> --group <group>` | Stop sharing a skill you own with a group. |
| `ahood skill init [name]` | Scaffold a new skill folder with a minimal, valid SKILL.md. |
| `ahood skill publish <owner>/<skill>@<version> [--path <dir>] [--kind skill\|agent\|mcp] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--changelog <text>] [--json]` | Publish a new version of a skill, agent, or mcp server manifest from a folder containing SKILL.md, AGENT.md, or server.json, creating the skill first if it doesn't already exist. |

### Agent

| Command | What it does |
| --- | --- |
| `ahood agent search <query> [--json] [--limit <n>]` | Search published agents. |
| `ahood agent view\|show <owner>/<agent> [--json] [--web]` | Show a single agent's details without installing it (alias: ahood agent show). |
| `ahood agent read <owner>/<agent> [--json]` | Print a published agent's AGENT.md, without installing it. |
| `ahood agent versions <owner>/<agent> [--json]` | List a agent's published-version history. |
| `ahood agent diff <owner>/<agent> <versionA> <versionB> [--json]` | Show what changed between two published versions of an agent. |
| `ahood agent list [--json]` | List your own agents, public and private. |
| `ahood agent add <owner>/<agent>[@version]` | Install an agent into .claude/agents/<owner>@<agent>.md, pinned in the lockfile. |
| `ahood agent update [<owner>/<agent> ...] [--dry-run] [--json]` | Move agent pins forward to the latest version. |
| `ahood agent outdated [<owner>/<agent> ...] [--json]` | Read-only staleness check for installed agents. |
| `ahood agent remove <owner>/<agent> [--yes]` | Uninstall and unpin an agent (local only, prompts unless --yes is passed). |
| `ahood agent edit <owner>/<agent> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]` | Update an agent you own, changing only the flags you pass. |
| `ahood agent unpublish <owner>/<agent>[@version] [--yes]` | Delete an agent from the registry for every consumer, or yank one version (prompts unless --yes is passed). |
| `ahood agent star <owner>/<agent>` | Star an agent. |
| `ahood agent unstar <owner>/<agent>` | Remove your star from an agent. |
| `ahood agent share <owner>/<agent> --group <group>` | Share an agent you own with a group, without changing its visibility. |
| `ahood agent unshare <owner>/<agent> --group <group>` | Stop sharing an agent you own with a group. |
| `ahood agent init [name]` | Scaffold a new agent folder with a minimal, valid AGENT.md. |
| `ahood agent publish <owner>/<agent>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--changelog <text>] [--json]` | Publish a new version of an agent from a folder containing AGENT.md, creating it first if it doesn't exist yet. |

### MCP (local server and server manifests)

| Command | What it does |
| --- | --- |
| `ahood mcp serve` | Start the local, read-only ahood MCP server over stdio (preferred spelling). |
| `ahood mcp` | Same as `ahood mcp serve`, kept byte-for-byte so existing MCP host configs keep working. |
| `ahood mcp search <query> [--json] [--limit <n>]` | Search published MCP server manifests. |
| `ahood mcp view\|show <owner>/<server> [--json] [--web]` | Show a single MCP server manifest's details without installing it (alias: ahood mcp show). |
| `ahood mcp read <owner>/<server> [--json]` | Print a published MCP server manifest's server.json, without installing it. |
| `ahood mcp versions <owner>/<server> [--json]` | List a MCP server manifest's published-version history. |
| `ahood mcp diff <owner>/<server> <versionA> <versionB> [--json]` | Show what changed between two published versions of an MCP server manifest. |
| `ahood mcp list [--json]` | List your own MCP server manifests, public and private. |
| `ahood mcp add <owner>/<server>[@version]` | Install an MCP server manifest into an entry in .mcp.json, pinned in the lockfile. |
| `ahood mcp update [<owner>/<server> ...] [--dry-run] [--json]` | Move MCP server manifest pins forward to the latest version. |
| `ahood mcp outdated [<owner>/<server> ...] [--json]` | Read-only staleness check for installed MCP server manifests. |
| `ahood mcp remove <owner>/<server> [--yes]` | Uninstall and unpin an MCP server manifest (local only, prompts unless --yes is passed). |
| `ahood mcp edit <owner>/<server> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]` | Update an MCP server manifest you own, changing only the flags you pass. |
| `ahood mcp unpublish <owner>/<server>[@version] [--yes]` | Delete an MCP server manifest from the registry for every consumer, or yank one version (prompts unless --yes is passed). |
| `ahood mcp star <owner>/<server>` | Star an MCP server manifest. |
| `ahood mcp unstar <owner>/<server>` | Remove your star from an MCP server manifest. |
| `ahood mcp share <owner>/<server> --group <group>` | Share an MCP server manifest you own with a group, without changing its visibility. |
| `ahood mcp unshare <owner>/<server> --group <group>` | Stop sharing an MCP server manifest you own with a group. |
| `ahood mcp init [name]` | Scaffold a new MCP server manifest folder with a minimal, valid server.json. |
| `ahood mcp publish <owner>/<server>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--changelog <text>] [--json]` | Publish a new version of an MCP server manifest from a folder containing server.json, creating it first if it doesn't exist yet. |

### Group

| Command | What it does |
| --- | --- |
| `ahood group create <name> [--description <text>]` | Create a private group, becoming its owner. |
| `ahood group list [--json]` | List groups you own or belong to. |
| `ahood group members <group> [--json]` | List a group's members and their role (owner-only visible to members). |
| `ahood group invite-link <group> [--json]` | Create (or regenerate) a shareable invite link for a group you own. |
| `ahood group join <invite-url-or-token>` | Join a group using an invite link or its raw token. |
| `ahood group remove-member <group> <username> [--yes]` | Remove a member from a group you own (prompts for confirmation unless --yes is passed). |
| `ahood group leave <group> [--yes]` | Leave a group you belong to (prompts for confirmation unless --yes is passed). |
| `ahood group delete <group> [--yes]` | Permanently delete a group you own (prompts for confirmation unless --yes is passed). |

### Snap

| Command | What it does |
| --- | --- |
| `ahood snap create <content> [--tags tag1,tag2] [--json]` | Capture a new private snap, from an argument or piped stdin. |
| `ahood snap list [--json] [--limit <n>] [--tags tag1,tag2]` | List your own snaps, most recent first. |
| `ahood snap search <query> [--json] [--limit <n>] [--tags tag1,tag2]` | Search your own snaps by content. |
| `ahood snap show <id> [--json]` | Print a single snap's full content. |
| `ahood snap remove <id> [--yes]` | Permanently delete a snap (prompts for confirmation unless --yes is passed). |
| `ahood snap share <id> [--json]` | Mint (or return the existing) shareable link for a snap. |
| `ahood snap unshare <id> [--yes]` | Revoke a snap's share link (the snap itself is untouched; prompts for confirmation unless --yes is passed). |
| `ahood snap tags <id> [tag ...] [--clear] [--json]` | Print a snap's tags, or replace them with the tags given. |
<!-- COMMANDS_TABLE_END -->

Run `ahood --help`, `ahood skill --help`, `ahood agent --help`, `ahood mcp --help`, `ahood group --help`, `ahood snap --help`, or `ahood <command> --help` (also `ahood help <command>` / `ahood help <skill|agent|mcp|group|snap> <verb>`) for the same reference — including per-command flags and examples — directly in your terminal. `ahood --version` prints the installed CLI version.

## Exit codes

Stable across releases, safe to branch on in a script:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General error |
| `2` | Usage or validation error (bad arguments, or the server rejected the request as invalid) |
| `4` | Authentication required or rejected (not logged in, or the token was refused) |
| `5` | Not found |
| `6` | Network/transport error, or an upstream server (5xx) error |

## Compatibility

Surfaces that are stable across releases on purpose, because something outside this codebase depends on their exact shape:

- **`User-Agent` header.** Every request sends `User-Agent: @ahood/cli/<version>` (e.g. `@ahood/cli/0.9.0`), built in `src/http.ts` from this package's own `name` and `version` in `package.json`. This is deliberately a plain, stable, parseable string rather than an opaque one, because it is exactly what a WAF/firewall allowlist rule needs to scope a rate limit or block rule to browser page traffic without also catching the CLI. **Changing this header's shape (its format, delimiter, or what it's derived from) is a breaking change** for anyone who has written a rule against it, even though nothing in this CLI's own test suite would fail — treat it with the same care as the [exit codes](#exit-codes) below. If it ever needs to carry more than name/version (for example OS or Node version, to make a spoofed string easier to tell apart from a real one), that's a deliberate compatibility change too and belongs in this same section, documented to match exactly what the code sends.

## Shell completion

```
# bash
ahood completion bash >> ~/.bashrc

# zsh
ahood completion zsh >> ~/.zshrc

# fish
ahood completion fish > ~/.config/fish/completions/ahood.fish
```

## Using ahood from an AI agent

`ahood` is built to be driven by an AI agent (Claude Code or otherwise) as comfortably as by a human at a terminal:

- **No interactive login required.** Set `AHOOD_TOKEN` once (a personal API token from `ahood token create <name>`) and every command works non-interactively.
- **Structured output everywhere.** `--json` is available on every read command and on `publish`/`update`, so an agent never has to scrape human-formatted text.
- **Predictable failure.** A stable, documented [exit code](#exit-codes) per failure class, and error messages that never leak raw upstream infrastructure details — safe to surface directly to an agent's reasoning loop.
- **A built-in guide for the agent itself.** `ahood help useme` prints a complete `SKILL.md` teaching an agent when and how to use ahood -- kinds, search -> read -> add -> update, publishing, `--json`, exit codes, `AHOOD_TOKEN`, the MCP options, and which commands are destructive. It is bundled with the installed CLI version, so it needs no login, no network, and writes nothing: stdout is the raw file and nothing else (diagnostics go to stderr), ready to paste into an agent's context or for an agent with a shell to read directly (`ahood help useme > ahood-SKILL.md` saves it). That is separate from `ahood skill add alexkay/ahood`, which optionally installs the registry-published ahood skill into a project as its own pinned skill.
- **A real "start here."** `ahood skill init <name>`, `ahood agent init <name>`, and `ahood mcp init <name>` scaffold a `SKILL.md`, `AGENT.md`, or `server.json` that passes the registry's publish validation, rather than requiring an agent to know each format up front.
- **A native MCP server, for agents that prefer tool calls to subprocess parsing.** `ahood mcp serve` (or bare `ahood mcp`, unchanged for existing configs) starts a Model Context Protocol server over stdio, exposing `skill_search`, `skill_view`, `skill_read`, `skill_versions`, `skill_list`, `skill_outdated`, and `whoami` as typed, read-only tools -- the same data the `--json` flags above already return, reachable as structured tool calls instead. Configure your MCP-aware agent host to run `ahood mcp serve` (or `npx @ahood/cli@latest mcp serve`) as a stdio server, e.g. `claude mcp add ahood -- ahood mcp serve`.

## Development

```
git clone https://github.com/AlexKay28/ahood-cli.git
cd ahood-cli
npm install
npm run build   # compile TypeScript -> dist/
npm test        # run the vitest suite
```

If you add or change a command, update `src/help.ts`'s `COMMANDS_HELP` and then run `npm run sync-readme` to regenerate the table above — CI fails (`node scripts/sync-readme.mjs --check`) if it's out of sync.

Full reference, including personal API tokens, the public REST API, and the MCP server: **https://ahood.vercel.app/docs**

## License

[MIT](LICENSE)
