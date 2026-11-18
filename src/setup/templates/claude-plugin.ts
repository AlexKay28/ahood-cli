// Claude Code plugin v2 (ahood#981): the slash commands in plugins/ahood/commands/,
// rendered from the same AHOOD_COMMANDS the Codex and opencode shells use, so
// all three harnesses say the same thing. The files are committed (Claude Code
// installs the plugin straight from this git repo, so nothing can generate
// them at install time); `npm run sync-plugin` rewrites them and
// tests/claude-plugin.test.ts fails when they drift from this module.
//
// Verified against Claude Code 2.1.282 (`claude plugin validate --strict`) and
// code.claude.com/docs/en/plugins-reference + /slash-commands (2026-10-28):
//   - A plugin's commands/<name>.md is `/<plugin>:<name>`, and bare `/<name>`
//     when no other command takes it. commands/ is flat: no nested
//     subcommands, so `/ahood sync` is `/ahood` with "sync" in $ARGUMENTS.
//   - Command front matter is the skill front matter minus name/paths:
//     description, argument-hint, allowed-tools, disable-model-invocation.
//   - allowed-tools pre-approves those tools only for the turn the command is
//     invoked in; the grant clears on the user's next message.
import { CLI_NAME, CLI_VERSION } from "../../version.js";
import { AHOOD_CLI, AHOOD_CLIENT_HEADER, AHOOD_COMMANDS, AHOOD_MCP_URL, ahoodClientHeaderValue, type AhoodCommand } from "./ahood-commands.js";

export const CLAUDE_PLUGIN_DIR = "plugins/ahood";

/**
 * The only tools each command pre-approves: the read-only CLI calls it starts
 * with, as exact commands, spelled as the bodies spell them (`npx -y
 * @ahood/cli@<version> ...`, ahood#1018) or the grant would never match.
 * Everything that changes state -- `sync <x> --yes`, `review approve|reject`,
 * `snap create`, `pin` -- is deliberately left out, so after the user says yes in chat Claude Code
 * still asks its own permission before running it (a second, independent
 * consent). An empty list means the command pre-approves nothing.
 */
const bash = (args: string) => `Bash(${AHOOD_CLI} ${args})`;
export const CLAUDE_COMMAND_ALLOWED_TOOLS: Record<string, string[]> = {
  ahood: [bash("status --json")],
  "ahood-find": [bash("find *")],
  "ahood-trending": [bash("find *")],
  "ahood-try": [bash("try *")],
  "ahood-install": [bash("skill view *"), bash("try *")],
  "ahood-prompt": [bash("prompt read *"), bash("prompt get *")],
  "ahood-loop": [bash("try *")],
  "ahood-project": [bash("project --json")],
  "ahood-star": [],
  "ahood-publish": [bash("stats --json"), bash("try *")],
  "ahood-stats": [bash("stats --json")],
  "ahood-sync": [bash("sync --dry-run --json"), bash("skill diff *")],
  "ahood-review": [bash("review --json"), bash("review show *")],
  "ahood-snap": [],
};

/** The `/ahood <verb>` arguments the dashboard command routes to another command's steps. */
export const CLAUDE_AHOOD_VERBS = AHOOD_COMMANDS.filter((c) => c.name !== "ahood").map((c) => c.name.replace(/^ahood-/, ""));

const GENERATED_NOTE =
  "<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->";

function frontMatter(description: string, argumentHint: string | null, allowedTools: string[]): string {
  const lines = ["---", `description: ${JSON.stringify(description)}`];
  if (argumentHint) lines.push(`argument-hint: ${JSON.stringify(argumentHint)}`);
  if (allowedTools.length > 0) lines.push("allowed-tools:", ...allowedTools.map((t) => `  - ${t}`));
  // The user starts these, never the model: sync, review and snap all lead to
  // a change the user must ask for. The ahood skill covers model-led use.
  lines.push("disable-model-invocation: true", "---");
  return lines.join("\n");
}

function byName(name: string): AhoodCommand {
  const found = AHOOD_COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`no ahood command named ${name}`);
  return found;
}

/** `/ahood [<verb>]`: the hub, or the matching command's steps. */
function dashboardFile(): string {
  const dashboard = byName("ahood");
  const verbs = AHOOD_COMMANDS.filter((c) => c.name !== "ahood");
  const allowed = [...new Set(AHOOD_COMMANDS.flatMap((c) => CLAUDE_COMMAND_ALLOWED_TOOLS[c.name] ?? []))];
  return [
    frontMatter(dashboard.description, `[${CLAUDE_AHOOD_VERBS.join("|")}]`, allowed),
    "",
    GENERATED_NOTE,
    "",
    "The user ran `/ahood $ARGUMENTS`. Pick the section that matches the first word of the arguments: " +
      `${CLAUDE_AHOOD_VERBS.map((v) => `\`${v}\``).join(", ")}. With no arguments (or \`status\`), show the hub.`,
    "",
    "## Hub",
    "",
    dashboard.body,
    ...verbs.flatMap((c) => ["", `## ${c.name.replace(/^ahood-/, "")}`, "", c.body]),
    "",
  ].join("\n");
}

function verbFile(c: AhoodCommand): string {
  return [
    frontMatter(c.description, null, CLAUDE_COMMAND_ALLOWED_TOOLS[c.name] ?? []),
    "",
    GENERATED_NOTE,
    "",
    c.body,
    "",
    "User arguments, if any: $ARGUMENTS",
    "",
  ].join("\n");
}

/** Every file under plugins/ahood/commands/, as paths relative to the plugin root. */
export function claudePluginCommandFiles(): Array<{ file: string; content: string }> {
  return AHOOD_COMMANDS.map((c) => ({
    file: `commands/${c.name}.md`,
    content: c.name === "ahood" ? dashboardFile() : verbFile(c),
  }));
}

const REPO_URL = "https://github.com/AlexKay28/ahood-cli";

/**
 * plugins/ahood/.claude-plugin/plugin.json, at the CLI's version (ahood#1018,
 * step A): one version for the CLI and all three plugins, generated, never
 * hand-bumped. Claude Code updates an installed plugin only when this
 * `version` changes, and the marketplace entry must not set one too (when
 * both are set, plugin.json wins silently and the entry only misleads).
 * `displayName` is the label Claude Code shows (ahood#1018 step E), so it can
 * change without renaming `name`, the id every install is keyed by: never
 * change `name`; record a rename, if one is ever needed, in an append-only
 * `renames` map instead.
 */
export function claudePluginManifest(): string {
  return `${JSON.stringify(
    {
      $schema: "https://anthropic.com/claude-code/plugin.schema.json",
      name: "ahood",
      displayName: "ahood",
      version: CLI_VERSION,
      description:
        "ahood in Claude Code: the registry's MCP tools (search, fetch, publish skills, agents, MCP servers, docs), plus " +
        "/ahood commands to find, try and install artifacts, use prompts and loops, publish, star, see your stats, " +
        "sync updates, review evolution proposals and capture private snaps.",
      author: { name: "ahood", url: REPO_URL },
      homepage: "https://www.ahood.dev/docs#mcp",
      repository: REPO_URL,
      license: "MIT",
      keywords: ["skills", "registry", "mcp", "agents", "ahood", "snaps"],
    },
    null,
    2,
  )}\n`;
}

/**
 * plugins/ahood/.mcp.json (ahood#1552 step 6): the hosted MCP server entry,
 * at the CLI's version. Alongside the existing Authorization header, it
 * carries `X-Ahood-Client: claude-plugin/<version>` so the server can tell
 * a Claude Code plugin request from a bare CLI one (which identifies
 * itself via User-Agent instead, http.ts) or another harness's plugin.
 * Generated, like plugin.json, so a release can never let the two drift.
 */
export function claudePluginMcpManifest(): string {
  return `${JSON.stringify(
    {
      ahood: {
        type: "http",
        url: AHOOD_MCP_URL,
        headers: { Authorization: "Bearer ${AHOOD_TOKEN}", [AHOOD_CLIENT_HEADER]: ahoodClientHeaderValue("claude-plugin") },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * plugins/ahood/hooks/hooks.json (ahood#1554 step 5): registers the
 * SessionStart hook below alongside the pre-existing, hand-written Stop
 * hook (hooks/snap-prompt.mjs -- NOT generated, and deliberately kept out
 * of claudePluginFiles() below: ahood#981's import-free/version-free
 * constraint on it has nothing to do with this feature). Generated, unlike
 * snap-prompt.mjs, because session-start.mjs needs the pinned CLI version
 * baked in (the same reason every /ahood command body does).
 */
export function claudePluginHooksManifest(): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"', timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/snap-prompt.mjs"', timeout: 10 }] }],
      },
    },
    null,
    2,
  )}\n`;
}

// The exact argv runStatus() below shells out to -- the same pinned-CLI
// shape every /ahood command body runs (ahood-commands.ts's AHOOD_CLI),
// just as an array instead of a backtick string (execFileSync takes argv,
// not a shell line).
const SESSION_START_ARGV = JSON.stringify(["npx", "-y", `${CLI_NAME}@${CLI_VERSION}`, "status", "--json"]);

/**
 * plugins/ahood/hooks/session-start.mjs (ahood#1554 step 5): a Claude Code
 * SessionStart hook. At most once per 24h (its own cache file, separate
 * from the CLI's own update-check.json: this runs inside the harness
 * process, not the CLI, and needs no npm-registry check of its own --
 * `ahood status --json` already carries both the update and notices
 * facts) it shells out to the pinned CLI's `status --json`, with a 3s
 * execFileSync timeout, and -- only when there is something to say --
 * returns `hookSpecificOutput.additionalContext` telling the agent to
 * SUGGEST `/ahood sync` and/or `npx @ahood/cli@latest setup`, and to never
 * run either itself (using-ahood's own "never sync on your own" rule).
 * Fails silently throughout: a missing token, a timeout, a malformed
 * response, an unwritable cache -- none of these may ever surface as an
 * error, a warning, or a delay at session start.
 */
export function claudePluginSessionStartHook(): string {
  return `#!/usr/bin/env node
// Generated from src/setup/templates/claude-plugin.ts's claudePluginSessionStartHook() by \`npm run sync-plugin\`; edit that function, not this file.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const CACHE_FILE_ENV = "AHOOD_SESSION_START_CACHE_FILE";
export const INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BUDGET_MS = 3000;
const ARGV = ${SESSION_START_ARGV};
const SEVERITY_RANK = { required: 2, action: 1, info: 0 };

function cachePath(env) {
  return env[CACHE_FILE_ENV] || join(env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "ahood-session-start"), "status-cache.json");
}

export function readCache(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.checked_at === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function isStale(cache, now = Date.now()) {
  if (!cache) return true;
  const checkedAt = Date.parse(cache.checked_at);
  return Number.isNaN(checkedAt) || now - checkedAt >= INTERVAL_MS;
}

function writeCache(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ checked_at: new Date().toISOString() }));
  } catch {
    // Best-effort: no cache written just means the next session tries again.
  }
}

/** Runs the pinned CLI's \`status --json\`, at most BUDGET_MS; null on any failure (no token, no network, a non-zero exit, a malformed response). */
export function runStatus(env) {
  try {
    const out = execFileSync(ARGV[0], ARGV.slice(1), { timeout: BUDGET_MS, encoding: "utf-8", env, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** The additionalContext text, or null when there is nothing worth telling the agent. */
export function buildContext(status) {
  if (!status) return null;
  const updates = Array.isArray(status.items) ? status.items.filter((i) => i && i.update_available) : [];
  const notices = Array.isArray(status.notices) ? status.notices : [];
  if (updates.length === 0 && notices.length === 0) return null;
  const lines = ["ahood: there is something to tell the user (relay it in one line; never run either suggestion yourself)."];
  if (updates.length > 0) lines.push(\`\${updates.length} installed skill/agent/MCP server update(s) are available.\`);
  if (notices.length > 0) {
    const top = notices.reduce((best, n) => ((SEVERITY_RANK[n.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0) ? n : best));
    lines.push(\`Notice (\${top.severity}): \${top.message}\`);
  }
  lines.push("Tell the user about this in one line and SUGGEST \`/ahood sync\` and/or \`npx @ahood/cli@latest setup\`; do not run either yourself.");
  return lines.join(" ");
}

/** The hook's decision for one SessionStart event: the JSON to print, or null to print nothing. */
export function decide(input, env) {
  if (!input || input.hook_event_name !== "SessionStart") return null;
  const path = cachePath(env);
  if (!isStale(readCache(path))) return null; // at most once per 24h -- nothing new to say this session
  writeCache(path);
  const context = buildContext(runStatus(env));
  if (!context) return null;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    return;
  }
  const out = decide(input, process.env);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    // A hook failure must never get in the way of starting the session.
  }
  process.exitCode = 0;
}
`;
}

/** Every Claude plugin file this module owns, as paths relative to the plugin root. */
export function claudePluginFiles(): Array<{ file: string; content: string }> {
  return [
    { file: ".claude-plugin/plugin.json", content: claudePluginManifest() },
    { file: ".mcp.json", content: claudePluginMcpManifest() },
    { file: "hooks/hooks.json", content: claudePluginHooksManifest() },
    { file: "hooks/session-start.mjs", content: claudePluginSessionStartHook() },
    ...claudePluginCommandFiles(),
  ];
}
