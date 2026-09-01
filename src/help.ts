// Canonical command list for terminal --help output. Kept in sync by hand
// with cli/README.md's table and app/docs/page.tsx's COMMANDS array (three
// copies of the same list, none of which can literally import from this
// file -- README.md is plain markdown and the docs page is a separate
// Next.js app) -- a comment in each of those two places points back here so
// a future command addition doesn't update only one.
//
// The command surface is split into two tiers, gh-style:
//   - TOP_LEVEL_COMMANDS_HELP: account/auth-scoped commands that stay flat
//     (login, logout, whoami, token, completion) -- same reasoning
//     `gh auth login` isn't `gh account login`.
//   - SKILL_COMMANDS_HELP: everything that operates on skills, all reached
//     as `ahood skill <verb>`. Future entities (e.g. "personality",
//     "protocols") get their own COMMANDS_HELP array alongside this one.
//
// `summary` is a genuinely one-sentence blurb used only by the top-level
// `ahood --help` / `ahood skill --help` listings. `desc` is the full
// (possibly multi-sentence) description rendered in full by `ahood help
// <command>` / `ahood skill <verb> --help`. Keep `summary` self-contained --
// it must not depend on the reader having also seen `desc`.
export type CommandHelp = { usage: string; summary: string; desc: string; flags?: string[]; examples?: string[] };

export const TOP_LEVEL_COMMANDS_HELP: CommandHelp[] = [
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
    usage: "ahood token create <name>|list [--json]|revoke <id> [--yes]",
    summary: "Manage personal API tokens.",
    desc: "Manage personal API tokens. `create` requires an existing browser-backed session.",
    flags: ["--yes    (revoke only) Skip the confirmation prompt and revoke immediately."],
    examples: ["ahood token create ci-runner", "ahood token list --json", "ahood token revoke <id>", "ahood token revoke <id> --yes"],
  },
  {
    usage: "ahood completion <bash|zsh|fish>",
    summary: "Print a shell completion script for the command names.",
    desc: "Print a shell completion script for the command names.",
    examples: ["ahood completion bash >> ~/.bashrc"],
  },
];

export const SKILL_COMMANDS_HELP: CommandHelp[] = [
  {
    usage: "ahood skill search <query> [--json] [--limit <n>]",
    summary: "Search published skills.",
    desc: "Search published skills.",
    flags: [
      "--json        Emit the raw skill objects instead of formatted lines.",
      "--limit <n>   Cap the number of results.",
    ],
    examples: ["ahood skill search pdf-tools", "ahood skill search pdf-tools --json"],
  },
  {
    usage: "ahood skill view <owner>/<skill> [--json] [--web]",
    summary:
      "Show a single skill's details -- tags, license, homepage, repository, dates, and more -- without installing it (alias: ahood skill show).",
    desc: "Show a single skill's details (tags, license, homepage, repository, dates, etc.) without installing it. Alias: ahood skill show.",
    flags: [
      "--json   Emit the raw skill object instead of formatted lines.",
      "--web    Open the skill's page in your browser instead of printing.",
    ],
  },
  {
    usage: "ahood skill versions <owner>/<skill> [--json]",
    summary: "List a skill's published-version history -- version, changelog, size, and publish date.",
    desc: "List a skill's published-version history: version, changelog, size, and publish date. Most-recent first.",
    flags: ["--json    Emit the raw version objects instead of formatted text."],
  },
  {
    usage: "ahood skill list [--json]",
    summary: "List your own skills, public and private.",
    desc: "List your own skills, public and private.",
    flags: ["--json    Emit the raw skill objects instead of formatted lines."],
  },
  {
    usage: "ahood skill add <owner>/<skill>[@version]",
    summary: "Install a skill into .claude/skills/, pinned in the lockfile.",
    desc: "Install a skill into .claude/skills/, pinned in the lockfile.",
    examples: ["ahood skill add alice/pdf-tools", "ahood skill add alice/pdf-tools@1.2.0"],
  },
  {
    usage: "ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]",
    summary: "Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once.",
    desc: "Move the lockfile pin(s) forward to the latest version. With no argument, updates every installed skill; one failure doesn't stop the rest.",
    flags: [
      "--dry-run   Preview current vs. latest version (and the changelog for anything behind) without installing anything.",
      "--json      With --dry-run, emit structured preview objects instead of a formatted table.",
    ],
    examples: ["ahood skill update --dry-run", "ahood skill update alice/pdf-tools --dry-run --json"],
  },
  {
    usage: "ahood skill remove <owner>/<skill>",
    summary: "Uninstall and unpin a skill (local only).",
    desc: "Uninstall and unpin (local only).",
  },
  {
    usage: "ahood skill edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]",
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
    examples: ['ahood skill edit alice/pdf-tools --tagline "Merge and split PDFs"'],
  },
  {
    usage: "ahood skill unpublish <owner>/<skill>[@version] [--yes]",
    summary:
      "Delete a skill from the registry for every consumer, or yank a single version, not just your local install (prompts for confirmation unless --yes is passed).",
    desc:
      "Without @version: delete a skill from the registry for every consumer (not just your local install). " +
      "With @version (e.g. alice/foo@1.2.3): yank that single version instead of deleting the whole skill -- " +
      "it is marked yanked, not removed. Existing lockfile pins still resolve and verify against it, but new " +
      "installs are warned off it. Prompts for a typed \"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  { usage: "ahood skill star <owner>/<skill>", summary: "Star a skill.", desc: "Star a skill." },
  {
    usage: "ahood skill unstar <owner>/<skill>",
    summary: "Remove your star from a skill.",
    desc: "Remove your star from a skill.",
  },
  {
    usage: "ahood skill init [name]",
    summary: "Scaffold a new skill folder with a minimal, valid SKILL.md.",
    desc:
      "Scaffold a new skill folder with a minimal, valid SKILL.md. Creates ./<name>/SKILL.md if a name is given, " +
      "or ./SKILL.md in the current directory otherwise. Refuses to overwrite an existing SKILL.md at the target path.",
    examples: ["ahood skill init pdf-tools", "ahood skill init"],
  },
  {
    usage:
      "ahood skill publish <owner>/<skill>@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--json]",
    summary:
      "Publish a new version of a skill from a folder containing SKILL.md, creating the skill first if it doesn't already exist.",
    desc:
      "Publish a new version of a skill from a folder containing SKILL.md. If the skill doesn't exist yet, this " +
      "creates it first -- pass --name (required in that case) and optionally --tagline/--tags/--license/--homepage/--repository. " +
      "Processing happens server-side after upload; this command polls and reports the final published/failed status. " +
      "The legacy form `ahood skill publish <path> --owner <owner> --slug <skill> --version <x.y.z>` is still accepted. " +
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
      "ahood skill publish alice/pdf-tools@1.1.0",
      'ahood skill publish alice/pdf-tools@1.0.0 --name "PDF Tools" --tagline "Merge and split PDFs"',
      "ahood skill publish alice/pdf-tools@1.1.0 --path ./pdf-tools",
    ],
  },
];

// Exported so other consumers of the command list (e.g. shell completion) can
// surface aliases without needing their own copy of this map. Aliases apply
// at the skill-verb level today (e.g. "show" for "view"); nothing at the
// top level currently has one.
export const COMMAND_ALIASES: Record<string, string> = { show: "view" };

// Two-token lookup for a skill-entity verb (findCommandHelp("skill", "search"))
// or a single-token lookup for a top-level command (findCommandHelp("whoami")).
export function findCommandHelp(command: string, subcommand?: string): CommandHelp | undefined {
  if (command === "skill" && subcommand !== undefined) {
    const resolved = COMMAND_ALIASES[subcommand] ?? subcommand;
    return SKILL_COMMANDS_HELP.find(
      (c) => c.usage.startsWith(`ahood skill ${resolved} `) || c.usage === `ahood skill ${resolved}`,
    );
  }
  const resolved = COMMAND_ALIASES[command] ?? command;
  return TOP_LEVEL_COMMANDS_HELP.find((c) => c.usage.startsWith(`ahood ${resolved} `) || c.usage === `ahood ${resolved}`);
}

// Renders a CommandHelp entry's usage line with any known aliases folded in
// after the primary command name, e.g. "ahood skill view <owner>/<skill> ..."
// -> "ahood skill view|show <owner>/<skill> ...". Used by the --help listings
// so aliases (like "show" for "view") aren't invisible to users who only
// skim `ahood --help` / `ahood skill --help`. The alias-carrying word is
// parts[2] for a skill-entity usage string ("ahood skill <verb> ...") and
// parts[1] for a top-level one ("ahood <command> ...").
export function usageWithAliases(entry: CommandHelp): string {
  const parts = entry.usage.split(" ");
  const idx = parts[1] === "skill" ? 2 : 1;
  const name = parts[idx];
  const aliases = Object.keys(COMMAND_ALIASES).filter((alias) => COMMAND_ALIASES[alias] === name);
  if (aliases.length === 0) return entry.usage;
  parts[idx] = [name, ...aliases].join("|");
  return parts.join(" ");
}

export function formatCommandHelp(entry: CommandHelp): string {
  const lines = [entry.usage, "", entry.desc];
  if (entry.flags?.length) lines.push("", "Flags:", ...entry.flags.map((f) => `  ${f}`));
  if (entry.examples?.length) lines.push("", "Examples:", ...entry.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}

// `ahood skill --help` -- the group-level listing for every skill verb.
export function formatSkillHelp(): string {
  const width = Math.max(...SKILL_COMMANDS_HELP.map((c) => usageWithAliases(c).length));
  const lines = SKILL_COMMANDS_HELP.map((c) => `  ${usageWithAliases(c).padEnd(width + 2)}${c.summary}`);
  return [
    "ahood skill -- manage skills in the ahood registry",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood skill <command> --help` for a single command's flags and examples.",
  ].join("\n");
}

// `ahood --help` -- the top-level listing: account commands rendered in
// full, plus a single summary line pointing at `ahood skill --help` for
// the (much longer) skill-entity command list.
export function formatHelp(): string {
  const skillGroupUsage = "ahood skill <command>";
  const skillGroupSummary = "Search, install, and publish skills -- run `ahood skill --help` for the full list.";
  const width = Math.max(...TOP_LEVEL_COMMANDS_HELP.map((c) => usageWithAliases(c).length), skillGroupUsage.length);
  const lines = [
    ...TOP_LEVEL_COMMANDS_HELP.map((c) => `  ${usageWithAliases(c).padEnd(width + 2)}${c.summary}`),
    `  ${skillGroupUsage.padEnd(width + 2)}${skillGroupSummary}`,
  ];
  return [
    "ahood -- CLI for the ahood skills registry (https://ahood.vercel.app)",
    "",
    "Quick start:",
    "  ahood login",
    "  ahood skill search <something>",
    "  ahood skill add <owner>/<skill>",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood <command> --help` (or `ahood help <command>`) for a single command's flags and examples.",
    "Run `ahood skill --help` for the full list of skill commands.",
    "Run `ahood --version` to print the installed CLI version.",
    "",
    "Exit codes: 0 success, 1 general error, 2 usage/validation error,",
    "            4 authentication required or rejected, 5 not found,",
    "            6 network/transport error or upstream server (5xx) error.",
    "",
    "Full reference: https://ahood.vercel.app/docs",
  ].join("\n");
}
