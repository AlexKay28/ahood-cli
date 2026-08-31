// Canonical command list for terminal --help output. Kept in sync by hand
// with cli/README.md's table and app/docs/page.tsx's COMMANDS array (three
// copies of the same list, none of which can literally import from this
// file -- README.md is plain markdown and the docs page is a separate
// Next.js app) -- a comment in each of those two places points back here so
// a future command addition doesn't update only one.
export type CommandHelp = { usage: string; desc: string; flags?: string[]; examples?: string[] };

export const COMMANDS_HELP: CommandHelp[] = [
  { usage: "ahood login", desc: "Device-code browser login, stores a token locally." },
  { usage: "ahood logout", desc: "Removes the stored token." },
  {
    usage: "ahood whoami [--json]",
    desc: "Reports whether your stored token still authenticates.",
    flags: ["--json    Emit a machine-readable result instead of prose."],
  },
  {
    usage: "ahood search <query> [--json] [--limit <n>]",
    desc: "Search published skills.",
    flags: [
      "--json        Emit the raw skill objects instead of formatted lines.",
      "--limit <n>   Cap the number of results.",
    ],
    examples: ["ahood search pdf-tools", "ahood search pdf-tools --json"],
  },
  {
    usage: "ahood view <owner>/<skill> [--json] [--web]",
    desc: "Show a single skill's details (tags, license, homepage, repository, dates, etc.) without installing it. Alias: ahood show.",
    flags: [
      "--json   Emit the raw skill object instead of formatted lines.",
      "--web    Open the skill's page in your browser instead of printing.",
    ],
  },
  {
    usage: "ahood list-mine [--json]",
    desc: "List your own skills, public and private.",
    flags: ["--json    Emit the raw skill objects instead of formatted lines."],
  },
  {
    usage: "ahood add <owner>/<skill>[@version]",
    desc: "Install a skill into .claude/skills/, pinned in the lockfile.",
    examples: ["ahood add alice/pdf-tools", "ahood add alice/pdf-tools@1.2.0"],
  },
  {
    usage: "ahood update [<owner>/<skill> ...]",
    desc: "Move the lockfile pin(s) forward to the latest version. With no argument, updates every installed skill; one failure doesn't stop the rest.",
  },
  { usage: "ahood remove <owner>/<skill>", desc: "Uninstall and unpin (local only)." },
  {
    usage: "ahood edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]",
    desc: "Update a skill you own. Only the flags you pass are changed.",
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
    usage: "ahood unpublish <owner>/<skill> [--yes]",
    desc: "Delete a skill from the registry for every consumer (not just your local install). Prompts for a typed \"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  { usage: "ahood star <owner>/<skill>", desc: "Star a skill." },
  { usage: "ahood unstar <owner>/<skill>", desc: "Remove your star from a skill." },
  {
    usage: "ahood publish <owner>/<skill>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>]",
    desc:
      "Publish a new version of a skill from a folder containing SKILL.md. If the skill doesn't exist yet, this " +
      "creates it first -- pass --name (required in that case) and optionally --tagline/--tags/--license/--homepage/--repository. " +
      "Processing happens server-side after upload; this command polls and reports the final published/failed status. " +
      "The legacy form `ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>` is still accepted.",
    flags: [
      "--name <text>                 Required only when creating the skill on this publish.",
      "--tagline <text>              Short one-line description, used only when creating.",
      "--tags <comma,separated>      Initial tags, used only when creating.",
      "--license <id>                An SPDX license identifier, e.g. MIT, used only when creating.",
      "--homepage <url>              The skill's homepage URL, used only when creating.",
      "--repository <url>            The skill's source repository URL, used only when creating.",
    ],
    examples: [
      "ahood publish alice/pdf-tools@1.1.0",
      'ahood publish alice/pdf-tools@1.0.0 --name "PDF Tools" --tagline "Merge and split PDFs"',
      "ahood publish alice/pdf-tools@1.1.0 --path ./pdf-tools",
    ],
  },
  {
    usage: "ahood token create <name>|list [--json]|revoke <id>",
    desc: "Manage personal API tokens. `create` requires an existing browser-backed session.",
    examples: ["ahood token create ci-runner", "ahood token list --json", "ahood token revoke <id>"],
  },
  {
    usage: "ahood completion <bash|zsh|fish>",
    desc: "Print a shell completion script for the command names.",
    examples: ["ahood completion bash >> ~/.bashrc"],
  },
];

const COMMAND_ALIASES: Record<string, string> = { show: "view" };

export function findCommandHelp(command: string): CommandHelp | undefined {
  const resolved = COMMAND_ALIASES[command] ?? command;
  return COMMANDS_HELP.find((c) => c.usage.startsWith(`ahood ${resolved} `) || c.usage === `ahood ${resolved}`);
}

export function formatCommandHelp(entry: CommandHelp): string {
  const lines = [entry.usage, "", entry.desc];
  if (entry.flags?.length) lines.push("", "Flags:", ...entry.flags.map((f) => `  ${f}`));
  if (entry.examples?.length) lines.push("", "Examples:", ...entry.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}

export function formatHelp(): string {
  const width = Math.max(...COMMANDS_HELP.map((c) => c.usage.length));
  const lines = COMMANDS_HELP.map((c) => `  ${c.usage.padEnd(width + 2)}${c.desc.split(". ")[0].replace(/\.$/, "")}.`);
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
    "            4 authentication required or rejected, 5 not found, 6 network/transport error.",
    "",
    "Full reference: https://ahood.vercel.app/docs",
  ].join("\n");
}
