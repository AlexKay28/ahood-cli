// Claude Code (ahood#980): the ahood plugin, installed and removed through
// the claude CLI's own `plugin` subcommands when it has them (detected from
// `claude plugin --help`, never assumed), otherwise as /plugin commands for
// the user to type in a session. Writes no files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "../paths.js";
import { runner } from "../runner.js";
import { AHOOD_SNAP_HOOK_ENV } from "../templates/ahood-commands.js";
import {
  CLAUDE_IN_SESSION_INSTALL,
  CLAUDE_IN_SESSION_REMOVE,
  CLAUDE_INSTALL_ARGS,
  CLAUDE_MARKETPLACE_NAME,
  CLAUDE_PLUGIN_ID,
  CLAUDE_REMOVE_ARGS,
} from "../templates/claude.js";
import { emptyPlan, type ConfigState, type Detection, type Feature, type Harness, type SetupPlan } from "./types.js";

type PluginEntry = { id: string; enabled?: boolean };

function detect(): Detection {
  const binary = runner().which("claude");
  const configDir = claudeDir();
  const configDirExists = existsSync(configDir);
  return { binary, configDir, configDirExists, installed: binary !== null || configDirExists };
}

function lists(help: string, verb: string): boolean {
  return new RegExp(`^\\s+${verb}(\\|\\S+)?\\s`, "m").test(help);
}

/** True when this claude CLI has `plugin install` and `plugin marketplace add` (claude-code 2.x does). */
export function claudeSupportsPluginCli(binary: string): boolean {
  const plugin = runner().run(binary, ["plugin", "--help"]);
  const marketplace = runner().run(binary, ["plugin", "marketplace", "--help"]);
  return plugin.status === 0 && marketplace.status === 0 && lists(plugin.stdout, "install") && lists(marketplace.stdout, "add");
}

function runJson<T>(binary: string, args: string[]): T | null {
  const result = runner().run(binary, args);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

function installedPlugins(binary: string | null): PluginEntry[] | null {
  if (binary) {
    const listed = runJson<PluginEntry[]>(binary, ["plugin", "list", "--json"]);
    if (Array.isArray(listed)) return listed;
  }
  // No CLI to ask: Claude Code's own record of installed plugins.
  const file = join(claudeDir(), "plugins", "installed_plugins.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { plugins?: Record<string, unknown> };
    return Object.keys(parsed.plugins ?? {}).map((id) => ({ id }));
  } catch {
    return null;
  }
}

function marketplaceAdded(binary: string): boolean {
  const listed = runJson<Array<{ name: string }>>(binary, ["plugin", "marketplace", "list", "--json"]);
  return Array.isArray(listed) && listed.some((m) => m.name === CLAUDE_MARKETPLACE_NAME);
}

function pluginInstalled(binary: string | null): boolean {
  return (installedPlugins(binary) ?? []).some((p) => p.id === CLAUDE_PLUGIN_ID);
}

function planSetup(): SetupPlan {
  const plan = emptyPlan();
  const { binary } = detect();
  if (!binary || !claudeSupportsPluginCli(binary)) {
    plan.notes.push(binary ? "this claude CLI has no `plugin` subcommands." : "the claude CLI is not on PATH.");
    plan.manual.push(...CLAUDE_IN_SESSION_INSTALL);
    return plan;
  }
  if (pluginInstalled(binary)) {
    plan.notes.push(`${CLAUDE_PLUGIN_ID} is already installed; Claude Code updates it with \`claude plugin update ${CLAUDE_PLUGIN_ID}\`.`);
    return plan;
  }
  if (!marketplaceAdded(binary)) {
    plan.commands.push({ bin: binary, args: [...CLAUDE_INSTALL_ARGS.marketplaceAdd], what: "add the ahood plugin marketplace" });
  }
  plan.commands.push({ bin: binary, args: [...CLAUDE_INSTALL_ARGS.pluginInstall], what: "install the ahood plugin" });
  return plan;
}

function planRemove(): SetupPlan {
  const plan = emptyPlan();
  const { binary } = detect();
  if (!binary || !claudeSupportsPluginCli(binary)) {
    plan.notes.push(binary ? "this claude CLI has no `plugin` subcommands." : "the claude CLI is not on PATH.");
    plan.manual.push(...CLAUDE_IN_SESSION_REMOVE);
    return plan;
  }
  if (pluginInstalled(binary)) {
    plan.commands.push({ bin: binary, args: [...CLAUDE_REMOVE_ARGS.pluginUninstall], what: "uninstall the ahood plugin" });
  }
  if (marketplaceAdded(binary)) {
    plan.commands.push({ bin: binary, args: [...CLAUDE_REMOVE_ARGS.marketplaceRemove], what: "remove the ahood plugin marketplace" });
  }
  if (plan.commands.length === 0) plan.notes.push("the ahood plugin is not installed; nothing to remove.");
  return plan;
}

/**
 * The opt-in snap Stop hook ships inside the plugin bundle itself (there is
 * nothing separate for setup to write), so its "feature" is just whether the
 * user has turned it on in this environment -- `absent` (off, the default) is
 * not a failure, same as an unset MCP token.
 */
function hookFeature(): Feature {
  return process.env[AHOOD_SNAP_HOOK_ENV] === "1"
    ? { name: "snap hook", state: "ok", detail: `${AHOOD_SNAP_HOOK_ENV}=1 -- snap prompt enabled` }
    : { name: "snap hook", state: "absent", detail: `opt-in, off by default -- set ${AHOOD_SNAP_HOOK_ENV}=1 to enable`, optional: true };
}

function inspect(): ConfigState {
  const { binary } = detect();
  const plugins = installedPlugins(binary);
  const ours = (plugins ?? []).filter((p) => p.id === CLAUDE_PLUGIN_ID);
  const hook = hookFeature();
  if (ours.length === 0) {
    const marketplace = binary !== null && marketplaceAdded(binary);
    return marketplace
      ? {
          state: "partial",
          details: [`marketplace "${CLAUDE_MARKETPLACE_NAME}" is added but ${CLAUDE_PLUGIN_ID} is not installed`],
          features: [{ name: "plugin", state: "partial", detail: `marketplace added, ${CLAUDE_PLUGIN_ID} not installed` }, hook],
        }
      : { state: "absent", details: [`${CLAUDE_PLUGIN_ID} not installed`], features: [{ name: "plugin", state: "absent", detail: `${CLAUDE_PLUGIN_ID} not installed` }, hook] };
  }
  if (ours.every((p) => p.enabled === false)) {
    return {
      state: "stale",
      details: [`${CLAUDE_PLUGIN_ID} is installed but disabled (claude plugin enable ${CLAUDE_PLUGIN_ID})`],
      features: [{ name: "plugin", state: "stale", detail: `installed but disabled (claude plugin enable ${CLAUDE_PLUGIN_ID})` }, hook],
    };
  }
  return { state: "ok", details: [`${CLAUDE_PLUGIN_ID} installed`], features: [{ name: "plugin", state: "ok", detail: `${CLAUDE_PLUGIN_ID} installed` }, hook] };
}

export const claudeHarness: Harness = { id: "claude", label: "Claude Code", detect, planSetup, planRemove, inspect };
