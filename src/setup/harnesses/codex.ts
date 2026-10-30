// Codex (ahood#980, ahood#1009): the ahood Codex plugin, named in a marked
// block in $CODEX_HOME/config.toml and installed by the codex CLI's own
// `plugin` subcommands when it has them (detected from `codex plugin --help`,
// never assumed). What setup wrote before ahood#1009 -- an
// `[mcp_servers.ahood]` block, $CODEX_HOME/skills/ahood/SKILL.md and an
// AGENTS.md snippet -- is taken out in the same run. Formats and what was
// verified: templates/codex.ts.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { SetupRefusedError } from "../errors.js";
import { OWNED_MARKER, planOwnedFileRemoval, readIfExists, type FileChange } from "../file-changes.js";
import { hasBlock, readBlock, removeBlock, upsertBlock } from "../marked-block.js";
import { codexHome, displayPath } from "../paths.js";
import { helpLists, runner } from "../runner.js";
import { AHOOD_MCP_URL } from "../templates/ahood-commands.js";
import {
  agentsSnippetFile,
  CODEX_AGENTS_MARKERS,
  CODEX_INSTALL_ARGS,
  CODEX_MARKETPLACE_NAME,
  CODEX_MARKETPLACE_REF,
  CODEX_MARKETPLACE_SOURCE,
  CODEX_MCP_SERVER_NAME,
  CODEX_PLUGIN_ID,
  CODEX_PLUGIN_NAME,
  CODEX_REMOVE_ARGS,
  CODEX_TOML_MARKERS,
  codexPluginBlock,
  codexSkill,
  codexStoredToken,
} from "../templates/codex.js";
import {
  emptyPlan,
  type ConfigState,
  type Detection,
  type Feature,
  type Harness,
  type SetupOptions,
  type SetupPlan,
  type TokenStore,
} from "./types.js";

const configPath = () => join(codexHome(), "config.toml");
// Written by setup before ahood#1009; now only ever removed.
const legacySkillPath = () => join(codexHome(), "skills", "ahood", "SKILL.md");
const legacySnippetPath = () => join(codexHome(), "ahood-agents-snippet.md");
const agentsPath = () => join(codexHome(), "AGENTS.md");
/** Where `codex plugin add` copies the plugin, one folder per version (codex-cli 0.165.0). */
const pluginCacheDir = () => join(codexHome(), "plugins", "cache", CODEX_MARKETPLACE_NAME, CODEX_PLUGIN_NAME);

function detect(): Detection {
  const binary = runner().which("codex");
  const configDir = codexHome();
  const configDirExists = existsSync(configDir);
  return { binary, configDir, configDirExists, installed: binary !== null || configDirExists };
}

type ParsedToml = {
  mcp_servers?: Record<string, { url?: unknown; http_headers?: unknown }>;
  marketplaces?: Record<string, { source?: unknown; ref?: unknown }>;
  plugins?: Record<string, { enabled?: unknown }>;
};

function parseOrRefuse(text: string, path: string, when: string): ParsedToml {
  try {
    return parseToml(text) as ParsedToml;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const subject = when ? `${displayPath(path)} ${when}` : displayPath(path);
    throw new SetupRefusedError(`${subject} is not valid TOML (${reason}). Fix it first; nothing was changed.`);
  }
}

/** The token setup stored in our block, or null (no block, or no token in it). */
function storedToken(): string | null {
  const path = configPath();
  const text = readIfExists(path);
  if (text === null) return null;
  try {
    if (!hasBlock(text, CODEX_TOML_MARKERS, displayPath(path))) return null;
    return codexStoredToken((parseToml(text) as ParsedToml).mcp_servers?.[CODEX_MCP_SERVER_NAME]);
  } catch {
    return null;
  }
}

/**
 * The ref our block pins the marketplace to: a string, null for a block that
 * names the marketplace unpinned (setup before the ref, so Codex tracks the
 * repo's default branch), undefined when there is no block with a marketplace.
 */
function blockRef(text: string | null, path: string): string | null | undefined {
  if (text === null) return undefined;
  try {
    if (!hasBlock(text, CODEX_TOML_MARKERS, displayPath(path))) return undefined;
    const marketplace = (parseToml(text) as ParsedToml).marketplaces?.[CODEX_MARKETPLACE_NAME];
    if (marketplace === undefined) return undefined;
    return typeof marketplace.ref === "string" ? marketplace.ref : null;
  } catch {
    return undefined;
  }
}

const describeRef = (ref: string | null) => (ref === null ? "unpinned (the repo's default branch)" : ref);

// ---- the codex CLI ----------------------------------------------------------

/** True when this codex CLI has `plugin add` and `plugin marketplace upgrade` (codex-cli 0.165.0 does). */
function supportsPluginCli(binary: string): boolean {
  const plugin = runner().run(binary, ["plugin", "--help"]);
  const marketplace = runner().run(binary, ["plugin", "marketplace", "--help"]);
  return plugin.status === 0 && marketplace.status === 0 && helpLists(plugin.stdout, "add") && helpLists(marketplace.stdout, "upgrade");
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

type InstalledPlugin = { version: string | null; enabled: boolean };

/**
 * Our plugin as Codex has it installed, or null. Asks `codex plugin list
 * --json` when there is a CLI (it fails while the marketplace was never
 * cloned: then nothing is installed either); without one, reads the plugin
 * cache and the `enabled` flag in config.toml.
 */
function installedPlugin(binary: string | null): InstalledPlugin | null {
  if (binary) {
    type Listed = { installed?: Array<{ pluginId?: string; version?: string; installed?: boolean; enabled?: boolean }> };
    const ours = runJson<Listed>(binary, ["plugin", "list", "--json"])?.installed?.find((p) => p.pluginId === CODEX_PLUGIN_ID);
    return ours?.installed ? { version: ours.version ?? null, enabled: ours.enabled === true } : null;
  }
  const versions = existsSync(pluginCacheDir()) ? readdirSync(pluginCacheDir()).sort() : [];
  if (versions.length === 0) return null;
  let enabled = false;
  try {
    enabled = (parseToml(readIfExists(configPath()) ?? "") as ParsedToml).plugins?.[CODEX_PLUGIN_ID]?.enabled === true;
  } catch {
    // an unreadable config enables nothing
  }
  return { version: versions[versions.length - 1], enabled };
}

function marketplaceCloned(binary: string): boolean {
  const listed = runJson<{ marketplaces?: Array<{ name?: string }> }>(binary, ["plugin", "marketplace", "list", "--json"]);
  return (listed?.marketplaces ?? []).some((m) => m.name === CODEX_MARKETPLACE_NAME);
}

// ---- config.toml ------------------------------------------------------------

/** A table the managed block writes that the user already has outside it: setup leaves theirs alone and stops. */
function userConflict(outside: ParsedToml): string | null {
  if (outside.marketplaces?.[CODEX_MARKETPLACE_NAME] !== undefined) return `[marketplaces.${CODEX_MARKETPLACE_NAME}]`;
  if (outside.plugins?.[CODEX_PLUGIN_ID] !== undefined) return `[plugins.${JSON.stringify(CODEX_PLUGIN_ID)}]`;
  // It would replace the plugin's own server, token and all.
  if (outside.mcp_servers?.[CODEX_MCP_SERVER_NAME] !== undefined) return `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`;
  return null;
}

function planConfig(remove: boolean, token: string | null = null): FileChange | null {
  const path = configPath();
  const before = readIfExists(path);
  const parsed = parseOrRefuse(before ?? "", path, "");
  const block = before === null ? null : readBlock(before, CODEX_TOML_MARKERS, displayPath(path));
  const previous = block !== null ? codexStoredToken(parsed.mcp_servers?.[CODEX_MCP_SERVER_NAME]) : null;
  const secrets = [previous, token].filter((t): t is string => t !== null);
  if (remove) {
    if (block === null) return null;
    const after = removeBlock(before!, CODEX_TOML_MARKERS, displayPath(path));
    parseOrRefuse(after, path, "without the ahood block");
    const what = previous ? "ahood plugin entries and stored token removed" : "ahood plugin entries removed";
    return { path, before, after: after.trim() === "" ? null : after, what, secrets };
  }
  const outside = block === null ? parsed : parseOrRefuse(removeBlock(before!, CODEX_TOML_MARKERS, displayPath(path)), path, "without the ahood block");
  const conflict = userConflict(outside);
  if (conflict) {
    throw new SetupRefusedError(
      `${displayPath(path)} already defines ${conflict} outside ahood's managed block -- leaving your entry alone. ` +
        "Delete it and re-run to let setup manage it; nothing was changed.",
    );
  }
  const after = upsertBlock(before ?? "", codexPluginBlock(token), CODEX_TOML_MARKERS, displayPath(path));
  const check = parseOrRefuse(after, path, "with the ahood block added");
  const works =
    check.marketplaces?.[CODEX_MARKETPLACE_NAME]?.source === CODEX_MARKETPLACE_SOURCE &&
    check.marketplaces?.[CODEX_MARKETPLACE_NAME]?.ref === CODEX_MARKETPLACE_REF &&
    check.plugins?.[CODEX_PLUGIN_ID]?.enabled === true &&
    (token === null || check.mcp_servers?.[CODEX_MCP_SERVER_NAME]?.url === AHOOD_MCP_URL);
  if (!works) {
    throw new SetupRefusedError(`Adding the ahood block to ${displayPath(path)} would not yield a working entry; nothing was changed.`);
  }
  const legacy = block !== null && block.includes(`[mcp_servers.${CODEX_MCP_SERVER_NAME}]`) && token === null;
  const previousRef = blockRef(before, path);
  const what =
    `plugin ${CODEX_PLUGIN_ID} from the "${CODEX_MARKETPLACE_NAME}" marketplace (${CODEX_MARKETPLACE_SOURCE} at ${CODEX_MARKETPLACE_REF})` +
    (previousRef !== undefined && previousRef !== CODEX_MARKETPLACE_REF ? `; marketplace re-pinned from ${describeRef(previousRef)}` : "") +
    (token ? `, with your ahood token in an [mcp_servers.${CODEX_MCP_SERVER_NAME}] entry that replaces the plugin's` : "") +
    (legacy ? `; the old [mcp_servers.${CODEX_MCP_SERVER_NAME}] entry goes (the plugin brings the MCP server)` : "");
  return { path, before, after, what, secrets };
}

/** Takes setup's old snippet out of $CODEX_HOME/AGENTS.md; the rest of the file is the user's. */
function planAgentsRemoval(): FileChange | null {
  const path = agentsPath();
  const before = readIfExists(path);
  if (before === null || !hasBlock(before, CODEX_AGENTS_MARKERS, displayPath(path))) return null;
  const after = removeBlock(before, CODEX_AGENTS_MARKERS, displayPath(path));
  return { path, before, after: after.trim() === "" ? null : after, what: "old ahood snippet removed (the plugin's using-ahood skill replaces it)" };
}

/** Everything setup wrote before ahood#1009 besides the TOML block (which planConfig rewrites in place). */
function legacyRemovals(notes: string[]): FileChange[] {
  return [
    planOwnedFileRemoval(legacySkillPath(), codexSkill(), "old `ahood` skill removed (the plugin ships it now)", notes),
    planOwnedFileRemoval(legacySnippetPath(), agentsSnippetFile(), "old AGENTS.md snippet file removed", notes),
    planAgentsRemoval(),
  ].filter((c): c is FileChange => c !== null);
}

const commandLine = (args: readonly string[]) => `codex ${args.join(" ")}`;

function planSetup(opts: SetupOptions): SetupPlan {
  const plan = emptyPlan();
  const previousRef = blockRef(readIfExists(configPath()), configPath());
  plan.files.push(planConfig(false, opts.token)!);
  // A same-named skill or snippet of the user's own is simply not ours to remove; no note at setup time.
  plan.files.push(...legacyRemovals([]));
  const { binary } = detect();
  if (!binary || !supportsPluginCli(binary)) {
    plan.notes.push(
      `${binary ? "this codex CLI has no `plugin` subcommands (update Codex)" : "the codex CLI is not on PATH"}; ` +
        `once it is, run \`${commandLine(CODEX_INSTALL_ARGS.marketplaceUpgrade)}\` and \`${commandLine(CODEX_INSTALL_ARGS.pluginAdd)}\` to install the plugin.`,
    );
    return plan;
  }
  if (installedPlugin(binary)) {
    // Installed from a marketplace checked out elsewhere (unpinned, or an older
    // CLI's tag): `marketplace upgrade` checks the new ref out and refreshes
    // the installed plugin with it (codex-cli 0.165.0).
    if (previousRef !== CODEX_MARKETPLACE_REF) {
      plan.commands.push({
        bin: binary,
        args: [...CODEX_INSTALL_ARGS.marketplaceUpgrade],
        what: `check the ahood plugin marketplace out at ${CODEX_MARKETPLACE_REF} (updates the installed plugin)`,
      });
      return plan;
    }
    plan.notes.push(
      `${CODEX_PLUGIN_ID} is already installed from ${CODEX_MARKETPLACE_REF}; after updating the CLI, re-run \`ahood setup codex\` to move it to the new release.`,
    );
    return plan;
  }
  plan.commands.push(
    { bin: binary, args: [...CODEX_INSTALL_ARGS.marketplaceUpgrade], what: "fetch the ahood plugin marketplace" },
    { bin: binary, args: [...CODEX_INSTALL_ARGS.pluginAdd], what: "install the ahood plugin" },
  );
  return plan;
}

function planRemove(): SetupPlan {
  const plan = emptyPlan();
  const config = planConfig(true);
  if (config) plan.files.push(config);
  plan.files.push(...legacyRemovals(plan.notes));
  const { binary } = detect();
  if (!binary || !supportsPluginCli(binary)) {
    if (existsSync(pluginCacheDir())) {
      plan.notes.push(`the codex CLI is not available to uninstall the plugin; its copy stays in ${displayPath(pluginCacheDir())} (unused once the block is gone).`);
    }
    return plan;
  }
  // Both run after the block is gone; neither then touches config.toml.
  if (installedPlugin(binary)) plan.commands.push({ bin: binary, args: [...CODEX_REMOVE_ARGS.pluginRemove], what: "uninstall the ahood plugin" });
  if (marketplaceCloned(binary)) {
    plan.commands.push({ bin: binary, args: [...CODEX_REMOVE_ARGS.marketplaceRemove], what: "remove the ahood plugin marketplace" });
  }
  return plan;
}

// ---- doctor -------------------------------------------------------------------

function inspect(): ConfigState {
  const path = configPath();
  const text = readIfExists(path);
  let config: Feature["state"] = "absent";
  let configDetail = displayPath(path);
  if (text !== null) {
    let block: string | null;
    try {
      parseToml(text);
      block = readBlock(text, CODEX_TOML_MARKERS, displayPath(path));
    } catch (error) {
      return {
        state: "broken",
        details: [`${displayPath(path)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`],
        features: [],
      };
    }
    if (block !== null) {
      // A pre-ahood#1009 block (just [mcp_servers.ahood]) is stale: re-running setup migrates it.
      config = block === `${CODEX_TOML_MARKERS.begin}\n${codexPluginBlock(storedToken())}\n${CODEX_TOML_MARKERS.end}` ? "ok" : "stale";
      const ref = blockRef(text, path);
      if (ref !== undefined) {
        configDetail +=
          ref === CODEX_MARKETPLACE_REF
            ? ` (marketplace ref ${ref})`
            : ` (marketplace ref ${describeRef(ref)}; this CLI pins ${CODEX_MARKETPLACE_REF} -- re-run \`ahood setup codex\`)`;
      }
    }
  }
  const { binary } = detect();
  const plugin = installedPlugin(binary);
  const pluginState: Feature["state"] = plugin === null ? "absent" : plugin.enabled ? "ok" : "stale";
  const version = plugin?.version ? ` ${plugin.version}` : "";
  const pluginDetail =
    plugin === null
      ? `${CODEX_PLUGIN_ID} not installed -- ${commandLine(CODEX_INSTALL_ARGS.pluginAdd)}`
      : plugin.enabled
        ? `${CODEX_PLUGIN_ID}${version} installed, enabled`
        : `${CODEX_PLUGIN_ID}${version} installed but disabled (enable it in Codex's /plugins, or re-run \`ahood setup codex\`)`;
  const features: Feature[] = [
    { name: "plugin config", state: config, detail: configDetail },
    { name: "plugin", state: pluginState, detail: pluginDetail },
  ];
  const leftovers = [legacySkillPath(), legacySnippetPath()].filter((p) => (readIfExists(p) ?? "").includes(OWNED_MARKER));
  if (leftovers.length > 0) {
    features.push({ name: "old setup files", state: "stale", detail: `${leftovers.map(displayPath).join(", ")} -- re-run \`ahood setup codex\` to remove` });
  }
  const details = [`plugin entries in ${configDetail}: ${config}`, pluginDetail];
  const tokenStored = storedToken() !== null;
  const states = features.map((f) => f.state);
  if (config === "absent" && pluginState === "absent" && leftovers.length === 0) return { state: "absent", details, features };
  if (config === "absent" || pluginState === "absent") return { state: "partial", details, features, tokenStored };
  if (states.includes("stale")) return { state: "stale", details, features, tokenStored };
  return { state: "ok", details, features, tokenStored };
}

const tokenStore: TokenStore = {
  file: configPath,
  stored: storedToken,
  userSet: () => false, // a [mcp_servers.ahood] of the user's own is refused outright (planConfig)
  what: `an [mcp_servers.${CODEX_MCP_SERVER_NAME}] entry in config.toml that replaces the plugin's`,
};

export const codexHarness: Harness = { id: "codex", label: "Codex", detect, planSetup, planRemove, inspect, tokenStore };
