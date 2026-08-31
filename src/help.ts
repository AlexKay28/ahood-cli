// Canonical command list for terminal --help output. Kept in sync by hand
// with cli/README.md's table and app/docs/page.tsx's COMMANDS array (three
// copies of the same list, none of which can literally import from this
// file -- README.md is plain markdown and the docs page is a separate
// Next.js app) -- a comment in each of those two places points back here so
// a future command addition doesn't update only one.
export type CommandHelp = { usage: string; desc: string };

export const COMMANDS_HELP: CommandHelp[] = [
  { usage: "ahood login", desc: "Device-code browser login, stores a token locally." },
  { usage: "ahood logout", desc: "Removes the stored token." },
  { usage: "ahood whoami", desc: "Reports whether your stored token still authenticates." },
  { usage: "ahood search <query>", desc: "Search published skills." },
  { usage: "ahood list-mine", desc: "List your own skills, public and private." },
  { usage: "ahood add <owner>/<skill>[@version]", desc: "Install a skill into .claude/skills/, pinned in the lockfile." },
  { usage: "ahood update [<owner>/<skill>]", desc: "Move the lockfile pin forward to the latest version." },
  { usage: "ahood remove <owner>/<skill>", desc: "Uninstall and unpin (local only)." },
  {
    usage: "ahood edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility]",
    desc: "Update a skill you own.",
  },
  { usage: "ahood unpublish <owner>/<skill>", desc: "Delete a skill from the registry (asks for confirmation)." },
  { usage: "ahood star <owner>/<skill>", desc: "Star a skill." },
  { usage: "ahood unstar <owner>/<skill>", desc: "Remove your star from a skill." },
  {
    usage: "ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>",
    desc: "Publish a new version of an existing skill.",
  },
  { usage: "ahood token create|list|revoke", desc: "Manage personal API tokens (requires a browser session)." },
];

export function findCommandHelp(command: string): CommandHelp | undefined {
  return COMMANDS_HELP.find((c) => c.usage === command || c.usage.startsWith(`ahood ${command} `) || c.usage === `ahood ${command}`);
}

export function formatHelp(): string {
  const width = Math.max(...COMMANDS_HELP.map((c) => c.usage.length));
  const lines = COMMANDS_HELP.map((c) => `  ${c.usage.padEnd(width + 2)}${c.desc}`);
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
    "Run `ahood <command> --help` for a single command's usage.",
    "Full reference: https://ahood.vercel.app/docs",
  ].join("\n");
}
