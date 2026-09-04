import { TOP_LEVEL_COMMANDS_HELP, SKILL_COMMANDS_HELP, COMMAND_ALIASES } from "../help.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood completion <bash|zsh|fish>";

// Position 1 (the word right after "ahood"): every top-level command plus
// the "skill" entity group itself.
function topLevelNames(): string[] {
  return [...TOP_LEVEL_COMMANDS_HELP.map((c) => c.usage.split(" ")[1]), "skill"];
}

// Position 2+, once "skill" has been typed: every skill verb, plus alias
// names (e.g. "show" for "view") so completion offers every name a user
// might type, not just the ones with their own SKILL_COMMANDS_HELP entry.
function skillNames(): string[] {
  const primary = SKILL_COMMANDS_HELP.map((c) => c.usage.split(" ")[2]);
  return [...primary, ...Object.keys(COMMAND_ALIASES)];
}

function bashCompletion(): string {
  const top = topLevelNames().join(" ");
  const skill = skillNames().join(" ");
  return [
    "_ahood_completions() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local top_words="${top}"`,
    `  local skill_words="${skill}"`,
    '  if [[ "${COMP_WORDS[1]}" == "skill" && $COMP_CWORD -ge 2 ]]; then',
    '    COMPREPLY=($(compgen -W "$skill_words" -- "$cur"))',
    "  else",
    '    COMPREPLY=($(compgen -W "$top_words" -- "$cur"))',
    "  fi",
    "}",
    "complete -F _ahood_completions ahood",
  ].join("\n");
}

function zshCompletion(): string {
  const top = topLevelNames().join(" ");
  const skill = skillNames().join(" ");
  return [
    "#compdef ahood",
    "local -a top_cmds skill_cmds",
    `top_cmds=(${top})`,
    `skill_cmds=(${skill})`,
    "case $words[2] in",
    "  skill)",
    '    _describe "skill command" skill_cmds',
    "    ;;",
    "  *)",
    '    _describe "command" top_cmds',
    "    ;;",
    "esac",
  ].join("\n");
}

function fishCompletion(): string {
  return [
    ...topLevelNames().map((name) => `complete -c ahood -n "__fish_use_subcommand" -a "${name}"`),
    ...skillNames().map((name) => `complete -c ahood -n "__fish_seen_subcommand_from skill" -a "${name}"`),
  ].join("\n");
}

// Position-aware command-name completion (not per-command flags) -- still
// the primary way users discover the available subcommands without reading
// docs, which this CLI otherwise has no mechanism for at all.
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
      throw new UsageError(USAGE);
  }
}
