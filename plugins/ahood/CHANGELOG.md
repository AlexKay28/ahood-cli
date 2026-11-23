# Changelog

What changed in the ahood Claude Code plugin, one section per release. The plugin's version is
the CLI's (`@ahood/cli`), so every section matches a `v<version>` tag of
[AlexKay28/ahood-cli](https://github.com/AlexKay28/ahood-cli/releases). Claude Code's "Plugin
updated" notice points here.

Releasing: add the `## <version>` section here and commit it **before** `npm version`. Its
`preversion` hook (and the release workflow) refuse a version without one
(`scripts/check-changelog.mjs`).

## 0.23.0 (2026-11-23)

- New `ahood <kind> vote <owner/slug> up|down [--note "..."] [--version x.y.z]` (and `--clear`) rates an
  artifact you have used, for every kind. `ahood view` shows its usage stats (views, reads, installs,
  stars, votes) and your own vote. `view` and `read` now tell the registry which one they are, so
  they are counted. After `add` or `read` in a terminal, a dim line reminds you to rate it.
- `AHOOD_AGENT=1` marks the CLI's requests as coming from an agent, so votes are recorded as an
  agent's. Nothing is detected automatically.
- The `using-ahood` skill now tells agents to vote, with a concrete note, after actually using an artifact.

## 0.22.0 (2026-11-21)

- A first-time user without an ahood account now hears that a command needs a free account
  (`ahood login`, or `npx @ahood/cli@latest setup` to connect your agent too), instead of being told
  their login "expired or was revoked". `ahood find` and `ahood skill search` also print the same
  search on the web, so you can still look before signing up.
- `ahood skill publish` takes `--visibility public|private`. When it creates a new artifact in a
  terminal without the flag, it asks whether to make it public. Otherwise the artifact stays private
  and publish prints the exact `ahood skill edit … --visibility public` command.

## 0.21.0 (2026-11-20)

- opencode: the `@ahood/opencode-plugin` now shows the same session-start notice as the Claude Code
  plugin. When a session starts it runs `ahood status` in the background and, if anything is out of
  date, adds one message naming it. It runs at most once per session, never for subagent sessions,
  and stays silent on any error. Set `AHOOD_NO_UPDATE_NOTIFIER=1` to turn it off.
- Codex has no session-start hook. There, the ahood MCP server's own instructions ask the agent to
  call `ahood_status` once at the start of a task.

## 0.20.1 (2026-11-19)

- The header on an installed skill now shows the skill's registry title (for example
  "Ahood Skill Registry") for every kind of install: a pinned `@version`, an update through
  `ahood sync`, and agents, docs and MCP servers. Before, these showed the slug.
- The session-start notice names what is out of date, for example
  `alexkay/ahood 2.7.0→2.8.0` (up to three, then "and N more"), and the CLI itself when it is
  behind, instead of only a count.

## 0.20.0 (2026-11-19)

- Every skill, agent and doc ahood installs now starts with a short header: its title, a link
  to its ahood page, and its version (it goes after the frontmatter, so skills still load).
  `ahood sync` ignores the header when comparing, and `ahood publish` strips it, so it never
  shows up as a change or gets republished. JSON files (MCP `server.json`) and prompts are
  left as they are.
- The CLI tells you, once a day at most, when a newer `@ahood/cli` is out (one line on stderr
  after a command; never with `--json`, in CI, when piped, or with `AHOOD_NO_UPDATE_NOTIFIER=1`).
- `ahood status` shows the most important notice from ahood, for example that your client is
  out of date, with the command to fix it.
- New session-start hook: at most once a day it checks your installed skills and the CLI and,
  only if something is out of date, tells the agent to suggest `/ahood sync` or
  `npx @ahood/cli@latest setup`. It never updates anything itself.
- The plugins and the CLI identify their version to ahood (`X-Ahood-Client`), so the server
  can tell you when an update is available.
- The using-ahood skill explains the header and how to relay a notice in one line.

## 0.19.0 (2026-11-15)

- The using-ahood skill and `/ahood-snap` follow a numbered snap protocol: one snap per artifact,
  find its exact `owner/slug` first (your ahood username, not a GitHub handle), and write the
  lesson as one general rule. Snaps written this way are the ones self-evolution can use.
- `ahood snap create` prints what the registry says about whether the snap feeds an artifact's
  self-evolution right after saving (which artifact, or why not, and which of your artifacts
  are enrolled when it doesn't). `--artifact` now also accepts a bare slug of your own artifact,
  not just `owner/slug` -- the server resolves it.

## 0.18.0 (2026-11-14)

- `ahood login` stops at the first real error from the server (for example "too many active
  tokens", or a server error) and prints it. Before, it waited about 10 minutes and then said
  "Login timed out".
- CLI logins now expire after 90 days. An expired or revoked login gets a clear message:
  "Your ahood login has expired or was revoked. Run `ahood login` again." If the rejected token
  came from `AHOOD_TOKEN`, the message says so instead.
- `ahood login` sends the server's one-time device code on every poll, in a header (never in
  the URL), so only the terminal that started a login can complete it.
- Lockfile entries record the skill's id. `ahood status` and `ahood sync` refuse an entry
  whose `owner/slug` now points at a different skill, and follow an owner rename to the new
  name.

## 0.17.0 (2026-11-10)

- `ahood publish` on an artifact that already exists now applies `--tagline`, `--tags`,
  `--license`, `--homepage` and `--repository` (they used to be applied only on the first
  publish). `--name` still only applies when creating.
- Account links point at the web app's new `/workspace/...` pages (tokens, evolution
  dashboard, group invite links). Old links keep working through the site's redirects.
- Updates come from the `release` branch: Claude Code and Codex now read the plugin from
  `AlexKay28/ahood-cli#release`, which each published release fast-forwards, so unreleased
  commits never reach you and every release does (opencode gets its plugin from npm,
  `@ahood/opencode-plugin`, which only a release publishes). Re-run
  `npx @ahood/cli@latest setup` once to move an existing install onto it.
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
