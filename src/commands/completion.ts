import { COMMANDS_HELP, COMMAND_ALIASES } from "../help.js";

const USAGE = "Usage: ahood completion <bash|zsh|fish>";

// Includes alias names (e.g. "show" for "view") alongside the primary
// command names, so shell completion offers every name a user might type,
// not just the ones with their own COMMANDS_HELP entry.
function commandNames(): string[] {
  const primary = COMMANDS_HELP.map((c) => c.usage.split(" ")[1]);
  return [...primary, ...Object.keys(COMMAND_ALIASES)];
}

function bashCompletion(): string {
  const names = commandNames().join(" ");
  return [
    "_ahood_completions() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=($(compgen -W "${names}" -- "$cur"))`,
    "}",
    "complete -F _ahood_completions ahood",
  ].join("\n");
}

function zshCompletion(): string {
  const names = commandNames().join(" ");
  return [
    "#compdef ahood",
    `_arguments '1: :(${names})'`,
  ].join("\n");
}

function fishCompletion(): string {
  return commandNames()
    .map((name) => `complete -c ahood -n "__fish_use_subcommand" -a "${name}"`)
    .join("\n");
}

// Command-name completion only (not per-command flags) -- still the primary
// way users discover the available subcommands without reading docs, which
// this CLI otherwise has no mechanism for at all.
export async function completion(args: string[]): Promise<void> {
  const shell = args[0];
  switch (shell) {
    case "bash":
      console.log(bashCompletion());
      return;
    case "zsh":
      console.log(zshCompletion());
      return;
    case "fish":
      console.log(fishCompletion());
      return;
    default:
      throw new Error(USAGE);
  }
}
