# ahood

CLI for [ahood](https://ahood.vercel.app), a registry for installing and publishing Claude Code skills.

## Install

```
npx ahood <command>
```

or install it globally:

```
npm i -g ahood
```

For CI or any non-interactive environment, set `AHOOD_TOKEN` instead of running `login` -- every command checks it first.

## Commands

| Command | What it does |
| --- | --- |
| `ahood login` | Device-code browser login, stores a token at `~/.config/ahood/credentials.json`. |
| `ahood logout` | Removes the stored token. |
| `ahood whoami` | Reports whether your stored token still authenticates. |
| `ahood search <query>` | Search published skills. |
| `ahood list-mine` | List your own skills, public and private, with their visibility and download/star counts. |
| `ahood add <owner>/<skill>[@version]` | Install into `.claude/skills/<owner>/<skill>/`, pinned in `.claude/skills.lock.json`. |
| `ahood update [<owner>/<skill>]` | Move the lockfile pin forward to the latest version. |
| `ahood remove <owner>/<skill>` | Uninstall and unpin (local only -- does not affect the published skill). |
| `ahood edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility]` | Update a skill you own. Only the flags you pass are changed; requires the `publish` scope. |
| `ahood unpublish <owner>/<skill>` | Deletes the skill from the registry for every consumer, not just your local install -- prompts for a typed "yes" confirmation first. |
| `ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>` | Publish a new version of an existing skill from a folder containing `SKILL.md`. The skill itself is created from the web UI first. |
| `ahood token create\|list\|revoke` | Manage personal API tokens. Creating a token requires an existing logged-in session -- see the docs. |

Full reference, including personal API tokens, CI usage, the public REST API, and the MCP server: **https://ahood.vercel.app/docs**
