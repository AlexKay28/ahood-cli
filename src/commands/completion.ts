import {
  TOP_LEVEL_COMMANDS_HELP,
  SKILL_COMMANDS_HELP,
  AGENT_COMMANDS_HELP,
  MCP_COMMANDS_HELP,
  GROUP_COMMANDS_HELP,
  SNAP_COMMANDS_HELP,
  COMMAND_ALIASES,
  type CommandHelp,
} from "../help.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood completion <bash|zsh|fish>";

// Every entity noun with its own verb list, in the order completion offers
// them. Registry nouns (skill, agent, mcp -- ahood-cli#172) come first; group
// and snap were already real nouns but had no completion at all before.
const NOUNS: Array<[string, CommandHelp[]]> = [
  ["skill", SKILL_COMMANDS_HELP],
  ["agent", AGENT_COMMANDS_HELP],
  ["mcp", MCP_COMMANDS_HELP],
  ["group", GROUP_COMMANDS_HELP],
  ["snap", SNAP_COMMANDS_HELP],
];

function unique(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

// Position 1 (the word right after "ahood"): every top-level command plus
// every entity noun.
function topLevelNames(): string[] {
  return unique([...TOP_LEVEL_COMMANDS_HELP.map((c) => c.usage.split(" ")[1]), ...NOUNS.map(([noun]) => noun)]);
}

// Position 2+, once a noun has been typed: that noun's verbs, plus alias
// names (e.g. "show" for "view") wherever the aliased verb exists, so
// completion offers every name a user might type. A bare `ahood mcp` entry
// has no verb word and contributes nothing.
function verbNames(entries: CommandHelp[]): string[] {
  const primary = entries.map((c) => c.usage.split(" ")[2] ?? "");
  const aliases = Object.keys(COMMAND_ALIASES).filter((alias) => primary.includes(COMMAND_ALIASES[alias]));
  return unique([...primary, ...aliases]);
}

// After `ahood help`: the self-skill guide plus every noun.
function helpNames(): string[] {
  return ["useme", ...NOUNS.map(([noun]) => noun)];
}

function bashCompletion(): string {
  const lines = [
    "_ahood_completions() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local top_words="${topLevelNames().join(" ")}"`,
    ...NOUNS.map(([noun, entries]) => `  local ${noun}_words="${verbNames(entries).join(" ")}"`),
    `  local help_words="${helpNames().join(" ")}"`,
  ];
  NOUNS.forEach(([noun], i) => {
    lines.push(`  ${i === 0 ? "if" : "elif"} [[ "\${COMP_WORDS[1]}" == "${noun}" && $COMP_CWORD -ge 2 ]]; then`);
    lines.push(`    COMPREPLY=($(compgen -W "$${noun}_words" -- "$cur"))`);
  });
  lines.push('  elif [[ "${COMP_WORDS[1]}" == "help" && $COMP_CWORD -eq 2 ]]; then');
  lines.push('    COMPREPLY=($(compgen -W "$help_words" -- "$cur"))');
  lines.push("  else");
  lines.push('    COMPREPLY=($(compgen -W "$top_words" -- "$cur"))');
  lines.push("  fi");
  lines.push("}");
  lines.push("complete -F _ahood_completions ahood");
  return lines.join("\n");
}

function zshCompletion(): string {
  const lines = [
    "#compdef ahood",
    `local -a top_cmds ${NOUNS.map(([noun]) => `${noun}_cmds`).join(" ")} help_cmds`,
    `top_cmds=(${topLevelNames().join(" ")})`,
    ...NOUNS.map(([noun, entries]) => `${noun}_cmds=(${verbNames(entries).join(" ")})`),
    `help_cmds=(${helpNames().join(" ")})`,
    "case $words[2] in",
  ];
  for (const [noun] of NOUNS) {
    lines.push(`  ${noun})`);
    lines.push(`    _describe "${noun} command" ${noun}_cmds`);
    lines.push("    ;;");
  }
  lines.push("  help)", '    _describe "help topic" help_cmds', "    ;;");
  lines.push("  *)", '    _describe "command" top_cmds', "    ;;", "esac");
  return lines.join("\n");
}

function fishCompletion(): string {
  return [
    ...topLevelNames().map((name) => `complete -c ahood -n "__fish_use_subcommand" -a "${name}"`),
    ...NOUNS.flatMap(([noun, entries]) =>
      verbNames(entries).map((name) => `complete -c ahood -n "__fish_seen_subcommand_from ${noun}" -a "${name}"`),
    ),
    ...helpNames().map((name) => `complete -c ahood -n "__fish_seen_subcommand_from help" -a "${name}"`),
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
