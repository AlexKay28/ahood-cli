// Shared harness for the ahood#980 setup/doctor tests: a temp HOME (and no
// CODEX_HOME / XDG_CONFIG_HOME / tokens leaking in from the real machine), and
// a fake runner standing in for the claude / codex / opencode CLIs, so no test
// ever runs a real harness binary or touches a real config.
import { vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { setRunnerForTests, type RunResult } from "../../src/setup/runner.js";

const ENV_KEYS = ["HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "AHOOD_TOKEN", "AHOOD_API_TOKEN", "AHOOD_API_URL", "AHOOD_SNAP_HOOK"] as const;

export function setupHomeEnv() {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = mkdtempSync(join(tmpdir(), "ahood-980-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  process.exitCode = 0;
  return {
    home,
    restore() {
      vi.unstubAllGlobals();
      rmSync(home, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.exitCode = 0;
    },
  };
}

/** Every file under `dir`, relative, sorted -- for "nothing was written" checks. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export type FakeBin = (args: string[]) => RunResult | string;
export type RunCall = { bin: string; args: string[]; timeoutMs?: number };

/** Installs a runner where only `bins` exist on PATH; returns the recorded calls and a restore. */
export function fakeRunner(bins: Record<string, FakeBin>) {
  const calls: RunCall[] = [];
  const restore = setRunnerForTests({
    which: (bin) => (bins[bin] ? `/fake/bin/${bin}` : null),
    run(path, args, opts) {
      const bin = basename(path);
      calls.push({ bin, args, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
      const handler = bins[bin];
      if (!handler) return { status: 127, stdout: "", stderr: "not found" };
      const result = handler(args);
      return typeof result === "string" ? { status: 0, stdout: result, stderr: "" } : result;
    },
  });
  return { calls, restore };
}

const CLAUDE_PLUGIN_HELP = `Usage: claude plugin|plugins [options] [command]

Commands:
  install|i [options] <plugin>         Install a plugin from available
  list [options]                       List installed plugins
  uninstall|remove [options] <plugin>  Uninstall an installed plugin
`;
const CLAUDE_MARKETPLACE_HELP = `Usage: claude plugin marketplace [options] [command]

Commands:
  add [options] <source>      Add a marketplace from a URL, path, or GitHub repo
  list [options]              List all configured marketplaces
  remove|rm [options] <name>  Remove a configured marketplace
`;

const claudeSettingsPath = () => join(process.env.HOME!, ".claude", "settings.json");
const readClaudeSettings = (): Record<string, any> => (existsSync(claudeSettingsPath()) ? JSON.parse(readFileSync(claudeSettingsPath(), "utf-8")) : {});
const writeClaudeSettings = (value: Record<string, unknown>) => {
  mkdirSync(join(process.env.HOME!, ".claude"), { recursive: true });
  writeFileSync(claudeSettingsPath(), `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * A claude CLI with `plugin` subcommands (or without, `supportsPlugins:
 * false`), holding its own state. Like claude 2.1.282 (ahood#1018 step B):
 * `marketplace add <repo>#<ref>` refuses a source other than the one
 * ~/.claude/settings.json declares, and otherwise rewrites that declaration
 * itself -- dropping any `autoUpdate` -- and re-serializes the whole file;
 * `marketplace list` shows a marketplace only while it matches the
 * declaration; `marketplace remove` deletes the declaration.
 * `ref`: the ref an already-added marketplace was cloned at (undefined = none).
 */
export function fakeClaude(
  state: { marketplace?: boolean; ref?: string; installed?: boolean; enabled?: boolean; supportsPlugins?: boolean; failInstall?: boolean } = {},
) {
  const s = { marketplace: false, ref: "release" as string | undefined, installed: false, enabled: true, supportsPlugins: true, failInstall: false, ...state };
  if ("ref" in state) s.ref = state.ref;
  const declared = () => readClaudeSettings().extraKnownMarketplaces?.ahood?.source as { repo?: string; ref?: string } | undefined;
  const matches = () => {
    const d = declared();
    return d === undefined || (d.repo === "AlexKay28/ahood-cli" && d.ref === s.ref);
  };
  const bin: FakeBin = (args) => {
    const cmd = args.join(" ");
    if (!s.supportsPlugins) return { status: 1, stdout: "", stderr: "error: unknown command 'plugin'" };
    if (cmd === "plugin --help") return CLAUDE_PLUGIN_HELP;
    if (cmd === "plugin marketplace --help") return CLAUDE_MARKETPLACE_HELP;
    if (cmd === "plugin list --json") return JSON.stringify(s.installed ? [{ id: "ahood@ahood", enabled: s.enabled }] : [{ id: "other@x", enabled: true }]);
    if (cmd === "plugin marketplace list --json") {
      const ref = s.ref === undefined ? {} : { ref: s.ref };
      return JSON.stringify(s.marketplace && matches() ? [{ name: "ahood", source: "github", repo: "AlexKay28/ahood-cli", ...ref }] : []);
    }
    const add = /^plugin marketplace add AlexKay28\/ahood-cli(?:#(\S+))?$/.exec(cmd);
    if (add) {
      const ref = add[1];
      const d = declared();
      if (d !== undefined && (d.repo !== "AlexKay28/ahood-cli" || d.ref !== ref)) {
        return { status: 1, stdout: "", stderr: 'Cannot add marketplace "ahood": its network source differs from the one declared for it in settings' };
      }
      const settings = readClaudeSettings();
      settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces, ahood: { source: { source: "github", repo: "AlexKay28/ahood-cli", ...(ref ? { ref } : {}) } } };
      writeClaudeSettings(settings);
      s.marketplace = true;
      s.ref = ref;
      return "added";
    }
    if (cmd === "plugin install ahood@ahood") {
      if (s.failInstall) return { status: 1, stdout: "", stderr: "boom" };
      return void (s.installed = true), "installed";
    }
    if (cmd === "plugin update ahood@ahood") return s.installed ? "updated" : { status: 1, stdout: "", stderr: "not installed" };
    if (cmd === "plugin uninstall ahood@ahood") return void (s.installed = false), "uninstalled";
    if (cmd === "plugin marketplace remove ahood") {
      const settings = readClaudeSettings();
      if (settings.extraKnownMarketplaces?.ahood) {
        delete settings.extraKnownMarketplaces.ahood;
        writeClaudeSettings(settings);
      }
      return void (s.marketplace = false), "removed";
    }
    return { status: 2, stdout: "", stderr: `unexpected: ${cmd}` };
  };
  return { state: s, bin };
}

/** opencode prints its version as `v2.1.2`. */
export const fakeOpencode = (version = "v2.1.2"): FakeBin => (args) => (args[0] === "--version" ? `${version}\n` : { status: 1, stdout: "", stderr: "" });

// Trimmed from codex-cli 0.165.0's own `--help` output.
const CODEX_PLUGIN_HELP = `Manage Codex plugins

Usage: codex plugin [OPTIONS] <COMMAND>

Commands:
  add          Install a plugin from a configured or remote marketplace
  list         List plugins available from configured and remote marketplaces
  marketplace  Add, list, upgrade, or remove configured plugin marketplaces
  remove       Uninstall a plugin and remove its local cache
`;
const CODEX_MARKETPLACE_HELP = `Add, list, upgrade, or remove configured plugin marketplaces

Usage: codex plugin marketplace [OPTIONS] <COMMAND>

Commands:
  add      Add a local or Git marketplace to the configured marketplace sources
  list     List plugin marketplaces Codex is currently considering and their roots
  upgrade  Refresh configured Git marketplace snapshots
  remove   Remove a configured marketplace source by name
`;

/**
 * A codex CLI with `plugin` subcommands (or without, `supportsPlugins:
 * false`), holding its own state: `cloned` = the ahood marketplace was
 * fetched, `installed` = ahood@ahood is in the plugin cache. Like the real
 * one, both `list --json` calls fail while the marketplace is configured but
 * never cloned, and `marketplace remove` fails on one that was never cloned.
 */
export function fakeCodex(state: { cloned?: boolean; installed?: boolean; enabled?: boolean; version?: string; supportsPlugins?: boolean; failAdd?: boolean } = {}) {
  const s = { cloned: false, installed: false, enabled: true, version: "0.14.0", supportsPlugins: true, failAdd: false, ...state };
  const unloaded = { status: 1, stdout: "", stderr: "Error: failed to load configured marketplace snapshot(s)" };
  const bin: FakeBin = (args) => {
    const cmd = args.join(" ");
    if (!s.supportsPlugins) return { status: 2, stdout: "", stderr: "error: unrecognized subcommand 'plugin'" };
    if (cmd === "plugin --help") return CODEX_PLUGIN_HELP;
    if (cmd === "plugin marketplace --help") return CODEX_MARKETPLACE_HELP;
    if (cmd === "plugin list --json") {
      if (!s.cloned) return unloaded;
      const ours = { pluginId: "ahood@ahood", name: "ahood", marketplaceName: "ahood", version: s.version, installed: true, enabled: s.enabled };
      return JSON.stringify({ installed: s.installed ? [ours] : [], available: [] });
    }
    if (cmd === "plugin marketplace list --json") return s.cloned ? JSON.stringify({ marketplaces: [{ name: "ahood", root: "/x" }] }) : unloaded;
    if (cmd === "plugin marketplace upgrade ahood") return void (s.cloned = true), "Upgraded 1 marketplace(s).";
    if (cmd === "plugin add ahood@ahood") {
      if (s.failAdd || !s.cloned) return { status: 1, stdout: "", stderr: "boom" };
      return void (s.installed = true), "Added plugin `ahood` from marketplace `ahood`.";
    }
    if (cmd === "plugin remove ahood@ahood") return void (s.installed = false), "Removed plugin `ahood` from marketplace `ahood`.";
    if (cmd === "plugin marketplace remove ahood") {
      if (!s.cloned) return { status: 1, stdout: "", stderr: "Error: marketplace `ahood` is not configured or installed" };
      return void (s.cloned = false), "Removed marketplace `ahood`.";
    }
    return { status: 2, stdout: "", stderr: `unexpected: ${cmd}` };
  };
  return { state: s, bin };
}
