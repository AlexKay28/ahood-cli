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
import { AHOOD_COMMANDS, type AhoodCommand } from "./ahood-commands.js";

export const CLAUDE_PLUGIN_DIR = "plugins/ahood";

/**
 * The only tools each command pre-approves: the read-only CLI calls it starts
 * with, as exact commands. Everything that changes state -- `ahood sync <x>
 * --yes`, `ahood review approve|reject`, `ahood snap create`, `ahood pin` --
 * is deliberately left out, so after the user says yes in chat Claude Code
 * still asks its own permission before running it (a second, independent
 * consent). An empty list means the command pre-approves nothing.
 */
export const CLAUDE_COMMAND_ALLOWED_TOOLS: Record<string, string[]> = {
  ahood: ["Bash(ahood status --json)"],
  "ahood-sync": ["Bash(ahood sync --dry-run --json)", "Bash(ahood skill diff *)"],
  "ahood-review": ["Bash(ahood review --json)"],
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

/** `/ahood [sync|review|snap]`: the dashboard, or the matching command's steps. */
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
      `${CLAUDE_AHOOD_VERBS.map((v) => `\`${v}\``).join(", ")}. With no arguments (or \`status\`), show the dashboard.`,
    "",
    "## Dashboard",
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
