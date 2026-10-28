// Where each harness keeps its user-level config (ahood#980). Read from the
// environment on every call, never cached, so a test that points HOME at a
// temp dir sees its own paths.
import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir(): string {
  return process.env.HOME || homedir();
}

// Claude Code: ~/.claude. Setup writes nothing here itself -- the plugin is
// installed through `claude plugin ...` -- the dir only signals "installed".
export function claudeDir(): string {
  return join(homeDir(), ".claude");
}

// Codex honours CODEX_HOME (verified against codex-cli 0.164: `codex mcp add`
// writes $CODEX_HOME/config.toml, and its skill-creator instructions say
// "create discoverable skills in $CODEX_HOME/skills, or ~/.codex/skills when
// CODEX_HOME is unset").
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homeDir(), ".codex");
}

// opencode's global config dir is $XDG_CONFIG_HOME/opencode (verified against
// opencode v2.1.2: `opencode debug paths` prints it as `config`).
export function opencodeConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homeDir(), ".config"), "opencode");
}

/** `~/...` for display, so summaries stay short and never leak a temp path prefix twice. */
export function displayPath(path: string): string {
  const home = homeDir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
