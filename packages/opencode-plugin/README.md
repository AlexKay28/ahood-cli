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
- **`/ahood` commands**, which call the ahood CLI (`npm i -g @ahood/cli`; they fall back to
  `npx -y @ahood/cli`), so they also need `ahood login` (or `AHOOD_TOKEN`) once:

| Type | Does |
| --- | --- |
| `/ahood` | Dashboard from `ahood status --json`: installed vs latest versions, pins, pending evolution proposals |
| `/ahood-sync` | `ahood sync --dry-run`, a diff per update, then `ahood sync <owner>/<slug> --yes` only for the updates you approve in chat |
| `/ahood-review` | `ahood review`, each proposal with its evidence, then `ahood review approve\|reject <id>` only on your decision |
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
