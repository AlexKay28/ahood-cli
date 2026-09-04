# `ahood mcp` — MCP server design

Status: approved for planning
Related: GitHub issue #83 ("Enhancement: expose ahood-cli as an MCP server")

## Problem

Today an AI agent that wants to use ahood has to shell out to `ahood skill search --json` (or similar) and parse stdout. That works, but it means every call is a subprocess spawn plus text parsing, and the agent can't get typed, structured results back through its normal tool-calling path the way it can with a native MCP server.

## Goal

Add `ahood mcp`, a new top-level command that starts a Model Context Protocol (MCP) server over stdio, exposing a subset of ahood's existing commands as MCP tools. Same functionality the CLI already has — this is a second way to reach it, not new capability.

## Non-goals (v1)

- No mutating tools (`skill_add`, `skill_update`, `skill_remove`, `skill_publish`, `skill_unpublish`, `skill_edit`, `star`/`unstar`, `share`/`unshare`, any `group_*` command). Read-only first; a mutating v1.1 is a separate, later spec once this ships and the pattern is proven.
- No new auth mechanism — reuses `AHOOD_TOKEN` / stored credentials exactly as every other command does today.
- No persistent session/state model. Every ahood command is already a stateless one-shot HTTP call; the MCP server doesn't need to be anything more than a long-running process relaying stateless calls.
- No HTTP/SSE transport. Stdio only, matching how every stdio-launched MCP server (Claude Code, Claude Desktop, etc.) actually gets invoked — an agent host spawns `ahood mcp` as a subprocess.

## Corrections to the originating issue

Issue #83 proposed "mirror clickcast's `clickcast mcp` approach." Investigation found:

- `clickcast` is a Python project; its MCP server uses Python's `FastMCP`, not `@modelcontextprotocol/sdk`. There's no TS pattern to literally mirror.
- `clickcast`'s separate `clickcast`/`clickcast-mcp`/`shared` npm packages exist only because `clickcast-mcp` is a thin npx shim that provisions an isolated Python venv and execs the real Python server inside it. That problem doesn't exist for ahood-cli, which is already native Node/TS — so a package split buys nothing here and costs lockstep-versioning overhead. **Decision: `ahood mcp` is a subcommand on the existing `@ahood/cli` package, not a separate package.**
- The one genuinely portable idea from `clickcast`'s server: every tool handler is wrapped so a thrown exception never crosses the MCP boundary raw — it's caught and turned into a structured `isError: true` result. Adopted here (see Error handling).
- Issue #83's proposed v1 tool list included `skill_add`/`skill_update`/`skill_remove`. Those commands have no `--json` mode today and print unconditional warnings (yanked-version notice, `scripts/` warning, "Installed..." lines) with no gate to suppress them — calling them directly would interleave plain text into MCP's stdio JSON-RPC stream and corrupt the protocol. Making them safe requires decoupling their console output from their control flow first, a separate and materially larger piece of work. **Decision: v1 ships read-only tools only; add/update/remove is out of scope here.**

## Architecture

```
ahood mcp  (src/commands/mcp.ts)
  -> src/mcp/server.ts    builds McpServer, registers tools, connects StdioServerTransport, blocks
       -> src/mcp/tools.ts     tool definitions: name, description, input schema, handler
       -> src/mcp/safe-tool.ts wraps every handler; catches thrown errors, maps to a structured isError result
```

`src/commands/mcp.ts` follows the same shape every other command already uses (`async function mcp(args: string[]): Promise<void>`), registered in `index.ts`'s top-level `COMMANDS` map next to `login`/`logout`/`whoami`/`token`/`completion` — an account/infra-scoped command, not a `skill` verb.

## Components

### Extracting typed core functions (the only change to existing command files)

Each of the 6 read commands' handler currently does the real work as a couple of lines wrapping a single `apiJson(...)` call, then either prints the JSON or formats it as text — but the function itself returns `void`. To hand an MCP tool a JS value instead of printed text, each of the 6 files gets one small extraction: pull that `apiJson` call into its own exported, typed function that the existing argv handler also calls. This is the same pattern `add.ts` already uses for `fetchVersionMeta` — no control-flow changes, no behavior change to any existing CLI output.

| Command | New exported function (indicative signature) |
| --- | --- |
| `search.ts` | `searchSkills(query: string, limit?: number): Promise<SearchResult>` |
| `view.ts` | `viewSkill(owner: string, skill: string): Promise<SkillDetail>` |
| `read.ts` | `readSkill(owner: string, skill: string): Promise<{version: string; content: string}>` |
| `versions.ts` | `listVersions(owner: string, skill: string): Promise<VersionsResponse>` |
| `list.ts` | `listOwnSkills(): Promise<{skills: OwnSkill[]}>` |
| `whoami.ts` | Already effectively there in shape (the try/catch branches) -- extract the same way for consistency. |

### `src/mcp/tools.ts`

One entry per tool: `{ name, description, inputSchema, handler }`. `inputSchema` uses whatever schema library `@modelcontextprotocol/sdk`'s `registerTool` expects (commonly Zod) -- confirmed and pinned during implementation planning, not guessed here.

v1 tool list (names match issue #83's own proposal):

- `skill_search` — `{query: string, limit?: number}`
- `skill_view` — `{owner: string, skill: string}`
- `skill_read` — `{owner: string, skill: string}`
- `skill_versions` — `{owner: string, skill: string}`
- `skill_list` — `{}` (requires auth; same as `ahood skill list` today)
- `whoami` — `{}`

### `src/mcp/safe-tool.ts`

Wraps each handler. On success, returns the core function's return value as the tool's structured content. On a thrown error, catches it and returns `isError: true` with a JSON content block: `{error: string, error_code: string}`.

## Error handling

Reuses the categorization `exit-code.ts`'s `exitCodeFor` already encodes, instead of inventing a second taxonomy:

| Thrown error | `error_code` |
| --- | --- |
| `UsageError` | `usage_error` |
| `ApiError` (401/403) | `auth_error` |
| `ApiError` (404) | `not_found` |
| `ApiError` (5xx) | `network_error` |
| `ApiError` (other 4xx) | `usage_error` |
| `NetworkError` | `network_error` |
| anything else | `general_error` |

The error's `.message` is used verbatim — both `ApiError` (via `http.ts`'s existing `sanitizeErrorMessage`) and `UsageError` messages are already safe to surface to a caller; no new sanitization layer is needed.

## Auth

No eager auth check at server startup. `resolveToken()` (existing `credentials.ts`) is called the same way every command already calls it, lazily, per tool invocation. Several v1 tools (`skill_search`, `skill_view`, `skill_read`, `skill_versions`) already work against public data with no token at all, matching today's CLI behavior exactly; `skill_list`/`whoami` will surface the normal `ApiError`(401/403) → `auth_error` path if unauthenticated.

## Testing

Uses `@modelcontextprotocol/sdk`'s in-process transport pairing (client and server connected directly in-memory, no subprocess spawn) to drive real `tools/call` requests against the actual server instance, with `fetch` mocked the same way existing command tests already do (`vi.stubGlobal("fetch", ...)`, matching `tests/search.test.ts` etc.). Per tool: one test for the success shape, one for a representative error shape (asserting `isError` and the correct `error_code`).

## Dependencies

New runtime dependency: `@modelcontextprotocol/sdk`. Exact version, and whether it requires a separate schema-library dependency (e.g. `zod`) alongside it, is confirmed and pinned during implementation planning rather than guessed in this spec.

## Documentation

`src/help.ts`'s `TOP_LEVEL_COMMANDS_HELP` gets a new entry for `ahood mcp`. `npm run sync-readme` regenerates the README's command table per the existing convention (enforced by CI's `sync-readme.mjs --check`). README likely also wants a short new section describing `ahood mcp` similar to the existing "Using ahood from an AI agent" section.

## Future work (explicitly out of scope here)

- v1.1: mutating tools (`skill_add`/`update`/`remove`), gated behind the console-output refactor described above.
- v2 (per issue #83): `skill_publish`/`unpublish`/`edit`/`star`/`unstar`/`share`/`unshare`, `group_*` — likely behind an explicit opt-in flag given their registry-wide, harder-to-reverse effects (especially `unpublish`).
