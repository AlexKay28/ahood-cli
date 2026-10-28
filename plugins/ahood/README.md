# ahood

Connects Claude Code to [ahood](https://www.ahood.dev)'s MCP server, so an agent can search,
fetch, read, and publish skills, agents, MCP servers, and docs directly from a session --
the same 20+ tools documented at [ahood.dev/docs#mcp](https://www.ahood.dev/docs#mcp).

This plugin is published from the [`AlexKay28/ahood-cli`](https://github.com/AlexKay28/ahood-cli)
marketplace. Install it with:

```
/plugin marketplace add AlexKay28/ahood-cli
/plugin install ahood@ahood
```

## Setup

1. Mint a personal access token at [ahood.dev/settings/tokens](https://www.ahood.dev/settings/tokens).
2. Set it as `AHOOD_API_TOKEN` in your environment (e.g. in your shell profile, or wherever
   you keep secrets for Claude Code).
3. Install this plugin. Claude Code will connect to `https://www.ahood.dev/api/mcp` using
   that token.

A token is required for every tool, including read-only ones (`search_skills`, `get_skill`,
etc.) -- a request to `https://www.ahood.dev/api/mcp` with no token is rejected outright. A
missing or invalid token will also reject the authoring tools (`create_skill`, `update_skill`,
and friends), which additionally require the `publish` scope.
