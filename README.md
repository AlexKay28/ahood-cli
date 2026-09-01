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
Installed alice/pdf-tools@1.4.0 to .claude/skills/alice/pdf-tools
```

---

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [Why ahood](#why-ahood)
- [Configuration](#configuration)
- [Usage examples](#usage-examples)
- [Commands](#commands)
- [Exit codes](#exit-codes)
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

Two files `ahood` reads and writes in your project, neither of which needs to be gitignored (the lockfile is meant to be committed, same as `package-lock.json`):

| Path | What's in it |
| --- | --- |
| `.claude/skills/<owner>/<skill>/` | Installed skill files. |
| `.claude/skills.lock.json` | Exact installed version + checksum per skill, written by `add`/`update`, read by every install to verify integrity. |

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
Installed alice/pdf-tools@1.4.0 to .claude/skills/alice/pdf-tools
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

### Skill

| Command | What it does |
| --- | --- |
| `ahood skill search <query> [--json] [--limit <n>]` | Search published skills. |
| `ahood skill view\|show <owner>/<skill> [--json] [--web]` | Show a single skill's details -- tags, license, homepage, repository, dates, and more -- without installing it (alias: ahood skill show). |
| `ahood skill read <owner>/<skill> [--json]` | Print a skill's full SKILL.md content, without installing it. |
| `ahood skill versions <owner>/<skill> [--json]` | List a skill's published-version history -- version, changelog, size, and publish date. |
| `ahood skill list [--json]` | List your own skills, public and private. |
| `ahood skill add <owner>/<skill>[@version]` | Install a skill into .claude/skills/, pinned in the lockfile. |
| `ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]` | Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once. |
| `ahood skill remove <owner>/<skill>` | Uninstall and unpin a skill (local only). |
| `ahood skill edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]` | Update a skill you own, changing only the flags you pass. |
| `ahood skill unpublish <owner>/<skill>[@version] [--yes]` | Delete a skill from the registry for every consumer, or yank a single version, not just your local install (prompts for confirmation unless --yes is passed). |
| `ahood skill star <owner>/<skill>` | Star a skill. |
| `ahood skill unstar <owner>/<skill>` | Remove your star from a skill. |
| `ahood skill share <owner>/<skill> --group <group>` | Share a skill you own with a group, without changing its public/private visibility. |
| `ahood skill unshare <owner>/<skill> --group <group>` | Stop sharing a skill you own with a group. |
| `ahood skill init [name]` | Scaffold a new skill folder with a minimal, valid SKILL.md. |
| `ahood skill publish <owner>/<skill>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--json]` | Publish a new version of a skill from a folder containing SKILL.md, creating the skill first if it doesn't already exist. |

### Group

| Command | What it does |
| --- | --- |
| `ahood group create <name> [--description <text>]` | Create a private group, becoming its owner. |
| `ahood group list [--json]` | List groups you own or belong to. |
| `ahood group members <group> [--json]` | List a group's members and their role (owner-only visible to members). |
| `ahood group invite-link <group> [--json]` | Create (or regenerate) a shareable invite link for a group you own. |
| `ahood group join <invite-url-or-token>` | Join a group using an invite link or its raw token. |
| `ahood group remove-member <group> <username>` | Remove a member from a group you own. |
| `ahood group leave <group>` | Leave a group you belong to. |
| `ahood group delete <group> [--yes]` | Permanently delete a group you own (prompts for confirmation unless --yes is passed). |
<!-- COMMANDS_TABLE_END -->

Run `ahood --help`, `ahood skill --help`, `ahood group --help`, or `ahood <command> --help` (also `ahood help <command>` / `ahood help skill <verb>` / `ahood help group <verb>`) for the same reference — including per-command flags and examples — directly in your terminal. `ahood --version` prints the installed CLI version.

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
- **A real "start here."** `ahood skill init <name>` scaffolds a valid `SKILL.md` an agent can extend, rather than requiring it to know the frontmatter format up front.

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
