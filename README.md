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

<!-- Kept in sync by hand with cli/src/help.ts's COMMANDS_HELP (the terminal
     --help output's source) and app/docs/page.tsx's COMMANDS array -- update
     all three when a command changes. -->

| Command | What it does |
| --- | --- |
| `ahood login` | Device-code browser login, stores a token at `~/.config/ahood/credentials.json` (or `$XDG_CONFIG_HOME/ahood/`). |
| `ahood logout` | Removes the stored token. |
| `ahood whoami [--json]` | Reports whether your stored token still authenticates. |
| `ahood search <query> [--json] [--limit <n>]` | Search published skills. |
| `ahood view <owner>/<skill> [--json] [--web]` (alias: `show`) | Show a single skill's details -- tags, license, homepage, repository, dates, etc. -- without installing it, or open its page in a browser. |
| `ahood versions <owner>/<skill> [--json]` | List a skill's published-version history -- version, changelog, size, and publish date. Most-recent first. |
| `ahood list-mine [--json]` | List your own skills, public and private, with their visibility and download/star counts. |
| `ahood add <owner>/<skill>[@version]` | Install into `.claude/skills/<owner>/<skill>/`, pinned in `.claude/skills.lock.json`. |
| `ahood update [<owner>/<skill> ...] [--dry-run] [--json]` | Move the lockfile pin(s) forward to the latest version. One skill failing to update doesn't stop the rest. `--dry-run` previews current vs. latest version (plus the changelog for anything behind) without installing anything; add `--json` for structured output. |
| `ahood remove <owner>/<skill>` | Uninstall and unpin (local only -- does not affect the published skill). |
| `ahood edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]` | Update a skill you own. Only the flags you pass are changed; requires the `publish` scope. |
| `ahood unpublish <owner>/<skill>[@version] [--yes]` | Without `@version`, deletes the skill from the registry for every consumer, not just your local install. With `@version`, yanks just that version instead of deleting the whole skill -- it's marked yanked, not removed; existing lockfile pins still resolve, but new installs are warned off it. Prompts for a typed "yes" confirmation, or pass `--yes` for scripts/CI. |
| `ahood star <owner>/<skill>` | Star a skill. |
| `ahood unstar <owner>/<skill>` | Remove your star from a skill. |
| `ahood init [name]` | Scaffold a new skill folder with a minimal, valid `SKILL.md` -- `./<name>/SKILL.md` if a name is given, `./SKILL.md` otherwise. Refuses to overwrite an existing `SKILL.md`. |
| `ahood publish <owner>/<skill>@<version> [--path <dir>] [--name] [--tagline] [--tags] [--license] [--homepage] [--repository] [--json]` | Publish a new version of a skill from a folder containing `SKILL.md` (defaults to the current directory). If the skill doesn't exist yet, creates it first -- `--name` is required in that case; `--tagline`/`--tags`/`--license`/`--homepage`/`--repository` are optional and only used at creation. Processing (validation, checksumming, secret scanning) happens server-side after upload; this command polls and reports the final published/failed status. `--json` suppresses human progress lines and prints one `{version,status,...}` JSON object on completion instead. The legacy form `ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>` is still accepted. |
| `ahood token create <name>\|list [--json]\|revoke <id>` | Manage personal API tokens. Creating a token requires an existing logged-in session -- see the docs. |
| `ahood completion <bash\|zsh\|fish>` | Print a shell completion script for the command names. |

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
