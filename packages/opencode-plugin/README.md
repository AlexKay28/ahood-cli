# @ahood/opencode-plugin

ahood in [opencode](https://opencode.ai) (v2). The plugin connects opencode to
[ahood](https://www.ahood.dev)'s hosted MCP server, so an agent can search, fetch, read and
publish skills, agents, MCP servers and docs (the tools documented at
[ahood.dev/docs#mcp](https://www.ahood.dev/docs#mcp)). It also adds the `/ahood` commands and an
opt-in snap prompt.

## Install

`npx @ahood/cli@latest setup opencode` does this for you (and adds the ahood MCP entry, with your
token stored there if you agree). By hand: add it to the `plugins` list of your global opencode config
(`~/.config/opencode/opencode.json` or `opencode.jsonc`):

```json
{ "plugins": ["@ahood/opencode-plugin"] }
```

or run `opencode plugin add @ahood/opencode-plugin`. opencode installs the package from npm the
next time it starts; `opencode plugin list` shows it, and `opencode plugin update` picks up new
versions.

## What it adds

- **The `ahood` MCP server** (`https://www.ahood.dev/api/mcp`). It sends the token in
  `$AHOOD_TOKEN` from the environment opencode runs in; the plugin never writes the token
  anywhere. If your opencode config already has an `mcp.servers.ahood` entry (for example one
  holding the token itself), the plugin leaves that entry in charge.
- **`/ahood` commands**, which run the ahood CLI as `npx -y @ahood/cli@<version>`, pinned to this
  plugin's CLI release (no global install needed). The CLI uses `AHOOD_TOKEN` when it is set;
  otherwise run `npx @ahood/cli login` once:

| Type | Does |
| --- | --- |
| `/ahood` | Hub: `ahood status --json` as a table (installed vs latest, pins, pending proposals, evolution on/off), a menu of every command below, and one suggested next action |
| `/ahood-find <need> [--kind <kind>]` | Finds a skill, agent, MCP server, doc, project guide, loop or prompt (`ahood find --json`): the top matches and why each fits; offers try or install |
| `/ahood-trending [--kind <kind>]` | The most installed artifacts, optionally of one kind (`ahood find --sort downloads`) |
| `/ahood-try <owner/slug>` | Reads an artifact into this session without installing it (`ahood try`) |
| `/ahood-install <owner/slug>` | Previews an artifact (version, contents, risks, where it writes), then installs it only after your yes |
| `/ahood-prompt <owner/slug>` | Asks for each of a prompt's inputs, fills it with `ahood prompt get`, shows it, and uses it once |
| `/ahood-loop <owner/slug>` | Loads a loop's rules (`ahood try`) and, after your yes, follows them for this session |
| `/ahood-project` | Loads this repository's project guide from ahood (`ahood project --json`), or offers to write and publish one |
| `/ahood-star <owner/slug>` | Stars an artifact you used, after your yes |
| `/ahood-publish` | Publishes the artifact in this directory, after a diff against the published version and your yes |
| `/ahood-stats` | Your artifacts' downloads and stars, totals, recent activity and evolution counts (`ahood stats --json`) |
| `/ahood-sync` | `ahood sync --dry-run`, a diff per update, then `ahood sync <owner>/<slug> --yes` only for the updates you approve in chat |
| `/ahood-review` | `ahood review --json`, each proposal with its diff and evidence, then `ahood review approve\|reject <id>` only on your decision |
| `/ahood-snap` | Drafts a structured, private snap of the session, shows it, and runs `ahood snap create ...` only if you say yes |

## Optional: snap prompt at the end of a task

Off by default. Start opencode with `AHOOD_SNAP_HOOK=1` in its environment to turn it on (the
same switch as the Claude Code plugin's Stop hook). Then, at most once per session, when the
first turn ends, the plugin asks the agent to draft a private ahood snap of what the session
learned and to **ask you before saving**. Subagent sessions are skipped. The plugin itself never
saves or sends a snap; saving is a separate step you agree to.

## Development

This package lives in [`AlexKay28/ahood-cli`](https://github.com/AlexKay28/ahood-cli) under
`packages/opencode-plugin`. Its `package.json` and `src/generated.ts` are generated from the
CLI's shared templates by `npm run sync-plugin` (edit `src/setup/templates/`, not them), and the
repo's `npm run build` builds it into `dist/`. To try a local build, list the built directory
instead of the package name: `{ "plugins": ["/path/to/ahood-cli/packages/opencode-plugin/dist"] }`.
