import { COMMANDS_HELP } from "../help.js";

const USAGE = "Usage: ahood completion <bash|zsh|fish>";

function commandNames(): string[] {
  return COMMANDS_HELP.map((c) => c.usage.split(" ")[1]);
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
