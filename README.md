# ahood

CLI for [ahood](https://ahood.vercel.app), a registry for installing and publishing Claude Code skills.

## Quick start

```
npx @ahood/cli@latest login
npx @ahood/cli@latest search <something>
npx @ahood/cli@latest add <owner>/<skill>
```

## Install

```
npx @ahood/cli@latest <command>
```

or install it globally, so the plain `ahood` command works without `npx`:

```
npm i -g @ahood/cli
ahood <command>
```

For CI or any non-interactive environment, set `AHOOD_TOKEN` instead of running `login` -- every command checks it first.

`AHOOD_API_URL` overrides the registry endpoint (defaults to `https://ahood.vercel.app`). It must be `https://`, except for `localhost`/`127.0.0.1` or an `.test`/`.invalid`/`.example`/`.localhost` host, which may use plain `http://` for local development.

## Commands

<!-- Generated from src/help.ts's COMMANDS_HELP by scripts/sync-readme.mjs --
     do not hand-edit the table below. Run `npm run sync-readme` after
     changing COMMANDS_HELP to regenerate it. -->

<!-- COMMANDS_TABLE_START -->
| Command | What it does |
| --- | --- |
| `ahood login` | Device-code browser login, stores a token locally. |
| `ahood logout` | Removes the stored token. |
| `ahood whoami [--json]` | Reports whether your stored token still authenticates. |
| `ahood search <query> [--json] [--limit <n>]` | Search published skills. |
| `ahood view\|show <owner>/<skill> [--json] [--web]` | Show a single skill's details -- tags, license, homepage, repository, dates, and more -- without installing it (alias: ahood show). |
| `ahood versions <owner>/<skill> [--json]` | List a skill's published-version history -- version, changelog, size, and publish date. |
| `ahood list-mine [--json]` | List your own skills, public and private. |
| `ahood add <owner>/<skill>[@version]` | Install a skill into .claude/skills/, pinned in the lockfile. |
| `ahood update [<owner>/<skill> ...] [--dry-run] [--json]` | Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once. |
| `ahood remove <owner>/<skill>` | Uninstall and unpin a skill (local only). |
| `ahood edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]` | Update a skill you own, changing only the flags you pass. |
| `ahood unpublish <owner>/<skill>[@version] [--yes]` | Delete a skill from the registry for every consumer, or yank a single version, not just your local install (prompts for confirmation unless --yes is passed). |
| `ahood star <owner>/<skill>` | Star a skill. |
| `ahood unstar <owner>/<skill>` | Remove your star from a skill. |
| `ahood init [name]` | Scaffold a new skill folder with a minimal, valid SKILL.md. |
| `ahood publish <owner>/<skill>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--json]` | Publish a new version of a skill from a folder containing SKILL.md, creating the skill first if it doesn't already exist. |
| `ahood token create <name>\|list [--json]\|revoke <id> [--yes]` | Manage personal API tokens. |
| `ahood completion <bash\|zsh\|fish>` | Print a shell completion script for the command names. |
<!-- COMMANDS_TABLE_END -->

Run `ahood help`, `ahood help <command>`, or `ahood <command> --help` for the same reference directly in your terminal. `ahood --version` prints the installed CLI version.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General error |
| `2` | Usage or validation error (bad arguments, or the server rejected the request as invalid) |
| `4` | Authentication required or rejected (not logged in, or the token was refused) |
| `5` | Not found |
| `6` | Network/transport error, or an upstream server (5xx) error |

Full reference, including personal API tokens, CI usage, the public REST API, and the MCP server: **https://ahood.vercel.app/docs**
