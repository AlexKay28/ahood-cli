// Canonical command list for terminal --help output. Kept in sync by hand
// with cli/README.md's table and app/docs/page.tsx's COMMANDS array (three
// copies of the same list, none of which can literally import from this
// file -- README.md is plain markdown and the docs page is a separate
// Next.js app) -- a comment in each of those two places points back here so
// a future command addition doesn't update only one.
// `summary` is a genuinely one-sentence blurb used only by the top-level
// `ahood --help` listing. `desc` is the full (possibly multi-sentence)
// description rendered in full by `ahood help <command>`. Keep `summary`
// self-contained -- it must not depend on the reader having also seen `desc`.
export type CommandHelp = { usage: string; summary: string; desc: string; flags?: string[]; examples?: string[] };

export const COMMANDS_HELP: CommandHelp[] = [
  {
    usage: "ahood login",
    summary: "Device-code browser login, stores a token locally.",
    desc: "Device-code browser login, stores a token locally.",
  },
  { usage: "ahood logout", summary: "Removes the stored token.", desc: "Removes the stored token." },
  {
    usage: "ahood whoami [--json]",
    summary: "Reports whether your stored token still authenticates.",
    desc: "Reports whether your stored token still authenticates.",
    flags: ["--json    Emit a machine-readable result instead of prose."],
  },
  {
    usage: "ahood search <query> [--json] [--limit <n>]",
    summary: "Search published skills.",
    desc: "Search published skills.",
    flags: [
      "--json        Emit the raw skill objects instead of formatted lines.",
      "--limit <n>   Cap the number of results.",
    ],
    examples: ["ahood search pdf-tools", "ahood search pdf-tools --json"],
  },
  {
    usage: "ahood view <owner>/<skill> [--json] [--web]",
    summary:
      "Show a single skill's details -- tags, license, homepage, repository, dates, and more -- without installing it (alias: ahood show).",
    desc: "Show a single skill's details (tags, license, homepage, repository, dates, etc.) without installing it. Alias: ahood show.",
    flags: [
      "--json   Emit the raw skill object instead of formatted lines.",
      "--web    Open the skill's page in your browser instead of printing.",
    ],
  },
  {
    usage: "ahood versions <owner>/<skill> [--json]",
    summary: "List a skill's published-version history -- version, changelog, size, and publish date.",
    desc: "List a skill's published-version history: version, changelog, size, and publish date. Most-recent first.",
    flags: ["--json    Emit the raw version objects instead of formatted text."],
  },
  {
    usage: "ahood list-mine [--json]",
    summary: "List your own skills, public and private.",
    desc: "List your own skills, public and private.",
    flags: ["--json    Emit the raw skill objects instead of formatted lines."],
  },
  {
    usage: "ahood add <owner>/<skill>[@version]",
    summary: "Install a skill into .claude/skills/, pinned in the lockfile.",
    desc: "Install a skill into .claude/skills/, pinned in the lockfile.",
    examples: ["ahood add alice/pdf-tools", "ahood add alice/pdf-tools@1.2.0"],
  },
  {
    usage: "ahood update [<owner>/<skill> ...] [--dry-run] [--json]",
    summary: "Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once.",
    desc: "Move the lockfile pin(s) forward to the latest version. With no argument, updates every installed skill; one failure doesn't stop the rest.",
    flags: [
      "--dry-run   Preview current vs. latest version (and the changelog for anything behind) without installing anything.",
      "--json      With --dry-run, emit structured preview objects instead of a formatted table.",
    ],
    examples: ["ahood update --dry-run", "ahood update alice/pdf-tools --dry-run --json"],
  },
  {
    usage: "ahood remove <owner>/<skill>",
    summary: "Uninstall and unpin a skill (local only).",
    desc: "Uninstall and unpin (local only).",
  },
  {
    usage: "ahood edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]",
    summary: "Update a skill you own, changing only the flags you pass.",
    desc:
      "Update a skill you own. Only the flags you pass are changed. Every flag also accepts " +
      "the --flag=value form (e.g. --tagline=--fast and cheap), needed when a value itself starts with --.",
    flags: [
      "--tagline <text>              Short one-line description.",
      "--tags <comma,separated>      Replaces the skill's tag list.",
      "--license <id>                An SPDX license identifier, e.g. MIT.",
      "--visibility public|private   Who can see and install the skill.",
      "--homepage <url>              The skill's homepage URL.",
      "--repository <url>            The skill's source repository URL.",
    ],
    examples: ['ahood edit alice/pdf-tools --tagline "Merge and split PDFs"'],
  },
  {
    usage: "ahood unpublish <owner>/<skill>[@version] [--yes]",
    summary:
      "Delete a skill from the registry for every consumer, or yank a single version, not just your local install (prompts for confirmation unless --yes is passed).",
    desc:
      "Without @version: delete a skill from the registry for every consumer (not just your local install). " +
      "With @version (e.g. alice/foo@1.2.3): yank that single version instead of deleting the whole skill -- " +
      "it is marked yanked, not removed. Existing lockfile pins still resolve and verify against it, but new " +
      "installs are warned off it. Prompts for a typed \"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  { usage: "ahood star <owner>/<skill>", summary: "Star a skill.", desc: "Star a skill." },
  {
    usage: "ahood unstar <owner>/<skill>",
    summary: "Remove your star from a skill.",
    desc: "Remove your star from a skill.",
  },
  {
    usage: "ahood init [name]",
    summary: "Scaffold a new skill folder with a minimal, valid SKILL.md.",
    desc:
      "Scaffold a new skill folder with a minimal, valid SKILL.md. Creates ./<name>/SKILL.md if a name is given, " +
      "or ./SKILL.md in the current directory otherwise. Refuses to overwrite an existing SKILL.md at the target path.",
    examples: ["ahood init pdf-tools", "ahood init"],
  },
  {
    usage:
      "ahood publish <owner>/<skill>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--json]",
    summary:
      "Publish a new version of a skill from a folder containing SKILL.md, creating the skill first if it doesn't already exist.",
    desc:
      "Publish a new version of a skill from a folder containing SKILL.md. If the skill doesn't exist yet, this " +
      "creates it first -- pass --name (required in that case) and optionally --tagline/--tags/--license/--homepage/--repository. " +
      "Processing happens server-side after upload; this command polls and reports the final published/failed status. " +
      "The legacy form `ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>` is still accepted. " +
      "Every flag also accepts the --flag=value form, needed when a value itself starts with --.",
    flags: [
      "--name <text>                 Required only when creating the skill on this publish.",
      "--tagline <text>              Short one-line description, used only when creating.",
      "--tags <comma,separated>      Initial tags, used only when creating.",
      "--license <id>                An SPDX license identifier, e.g. MIT, used only when creating.",
      "--homepage <url>              The skill's homepage URL, used only when creating.",
      "--repository <url>            The skill's source repository URL, used only when creating.",
      "--json                        Suppress human progress lines; print one {version,status,...} JSON object on completion (or {error} on failure).",
    ],
    examples: [
      "ahood publish alice/pdf-tools@1.1.0",
      'ahood publish alice/pdf-tools@1.0.0 --name "PDF Tools" --tagline "Merge and split PDFs"',
      "ahood publish alice/pdf-tools@1.1.0 --path ./pdf-tools",
    ],
  },
  {
    usage: "ahood token create <name>|list [--json]|revoke <id>",
    summary: "Manage personal API tokens.",
    desc: "Manage personal API tokens. `create` requires an existing browser-backed session.",
    examples: ["ahood token create ci-runner", "ahood token list --json", "ahood token revoke <id>"],
  },
  {
    usage: "ahood completion <bash|zsh|fish>",
    summary: "Print a shell completion script for the command names.",
    desc: "Print a shell completion script for the command names.",
    examples: ["ahood completion bash >> ~/.bashrc"],
  },
];

// Exported so other consumers of the command list (e.g. shell completion) can
// surface aliases without needing their own copy of this map.
export const COMMAND_ALIASES: Record<string, string> = { show: "view" };

export function findCommandHelp(command: string): CommandHelp | undefined {
  const resolved = COMMAND_ALIASES[command] ?? command;
  return COMMANDS_HELP.find((c) => c.usage.startsWith(`ahood ${resolved} `) || c.usage === `ahood ${resolved}`);
}

// Renders a COMMANDS_HELP entry's usage line with any known aliases folded in
// after the primary command name, e.g. "ahood view <owner>/<skill> ..." ->
// "ahood view|show <owner>/<skill> ...". Used by the top-level --help listing
// so aliases (like "show" for "view") aren't invisible to users who only
// skim `ahood --help`.
export function usageWithAliases(entry: CommandHelp): string {
  const parts = entry.usage.split(" ");
  const name = parts[1];
  const aliases = Object.keys(COMMAND_ALIASES).filter((alias) => COMMAND_ALIASES[alias] === name);
  if (aliases.length === 0) return entry.usage;
  parts[1] = [name, ...aliases].join("|");
  return parts.join(" ");
}

export function formatCommandHelp(entry: CommandHelp): string {
  const lines = [entry.usage, "", entry.desc];
  if (entry.flags?.length) lines.push("", "Flags:", ...entry.flags.map((f) => `  ${f}`));
  if (entry.examples?.length) lines.push("", "Examples:", ...entry.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}

export function formatHelp(): string {
  const width = Math.max(...COMMANDS_HELP.map((c) => usageWithAliases(c).length));
  const lines = COMMANDS_HELP.map((c) => `  ${usageWithAliases(c).padEnd(width + 2)}${c.summary}`);
  return [
    "ahood -- CLI for the ahood skills registry (https://ahood.vercel.app)",
    "",
    "Quick start:",
    "  ahood login",
    "  ahood search <something>",
    "  ahood add <owner>/<skill>",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood <command> --help` (or `ahood help <command>`) for a single command's flags and examples.",
    "Run `ahood --version` to print the installed CLI version.",
    "",
    "Exit codes: 0 success, 1 general error, 2 usage/validation error,",
    "            4 authentication required or rejected, 5 not found,",
    "            6 network/transport error or upstream server (5xx) error.",
    "",
    "Full reference: https://ahood.vercel.app/docs",
  ].join("\n");
}
