// Claude Code (ahood#980): the ahood plugin, installed and removed through
// the claude CLI's own `plugin` subcommands when it has them (detected from
// `claude plugin --help`, never assumed), otherwise as /plugin commands for
// the user to type in a session. The one file it may edit, only with the
// user's consent, is ~/.claude/settings.json: `env.AHOOD_TOKEN` (ahood#990).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { SetupRefusedError } from "../errors.js";
import { readIfExists, type FileChange } from "../file-changes.js";
import { claudeDir, displayPath } from "../paths.js";
import { helpLists, runner } from "../runner.js";
import { AHOOD_SNAP_HOOK_ENV } from "../templates/ahood-commands.js";
import { releaseBranchMissing } from "../release-channel.js";
import {
  CLAUDE_IN_SESSION_INSTALL,
  CLAUDE_IN_SESSION_REMOVE,
  CLAUDE_INSTALL_ARGS,
  CLAUDE_MARKETPLACE_NAME,
  CLAUDE_MARKETPLACE_REF,
  CLAUDE_MARKETPLACE_REPO,
  CLAUDE_MARKETPLACE_SOURCE,
  CLAUDE_PLUGIN_ID,
  CLAUDE_REMOVE_ARGS,
  CLAUDE_TOKEN_ENV_KEY,
  CLAUDE_TOKEN_MARKER_KEY,
  CLAUDE_TOKEN_MARKER_VALUE,
} from "../templates/claude.js";
import {
  emptyPlan,
  type ConfigState,
  type DeferredChange,
  type Detection,
  type Feature,
  type Harness,
  type SetupOptions,
  type SetupPlan,
  type TokenStore,
} from "./types.js";

type PluginEntry = { id: string; enabled?: boolean };

function detect(): Detection {
  const binary = runner().which("claude");
  const configDir = claudeDir();
  const configDirExists = existsSync(configDir);
  return { binary, configDir, configDirExists, installed: binary !== null || configDirExists };
}

/** True when this claude CLI has `plugin install` and `plugin marketplace add` (claude-code 2.x does). */
export function claudeSupportsPluginCli(binary: string): boolean {
  const plugin = runner().run(binary, ["plugin", "--help"]);
  const marketplace = runner().run(binary, ["plugin", "marketplace", "--help"]);
  return plugin.status === 0 && marketplace.status === 0 && helpLists(plugin.stdout, "install") && helpLists(marketplace.stdout, "add");
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

type ListedMarketplace = { name: string; source?: string; repo?: string; ref?: string };

/** Our marketplace as `claude plugin marketplace list --json` shows it (with `ref` when it has one), or null. */
function listedMarketplace(binary: string): ListedMarketplace | null {
  const listed = runJson<ListedMarketplace[]>(binary, ["plugin", "marketplace", "list", "--json"]);
  return (Array.isArray(listed) ? listed.find((m) => m.name === CLAUDE_MARKETPLACE_NAME) : undefined) ?? null;
}

function marketplaceAdded(binary: string): boolean {
  return listedMarketplace(binary) !== null;
}

function pluginInstalled(binary: string | null): boolean {
  return (installedPlugins(binary) ?? []).some((p) => p.id === CLAUDE_PLUGIN_ID);
}

// ---- the token in ~/.claude/settings.json (ahood#990) ----------------------

const settingsPath = () => join(claudeDir(), "settings.json");
type SettingsEnv = Record<string, unknown>;
type Settings = { text: string | null; env: SettingsEnv; value: Record<string, unknown> };

function readSettings(): Settings {
  const path = settingsPath();
  const text = readIfExists(path);
  if (text === null) return { text, env: {}, value: {} };
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new SetupRefusedError(
      `${displayPath(path)} is not valid JSON (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}). Fix it first; nothing was changed.`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupRefusedError(`${displayPath(path)} is not a JSON object. Fix it first; nothing was changed.`);
  }
  const env = (value as { env?: unknown }).env;
  return {
    text,
    env: env !== null && typeof env === "object" && !Array.isArray(env) ? (env as SettingsEnv) : {},
    value: value as Record<string, unknown>,
  };
}

export function settingsTokenState(): { stored: string | null; userSet: boolean } {
  try {
    const { env } = readSettings();
    const token = typeof env[CLAUDE_TOKEN_ENV_KEY] === "string" ? (env[CLAUDE_TOKEN_ENV_KEY] as string) : null;
    const ours = env[CLAUDE_TOKEN_MARKER_KEY] === CLAUDE_TOKEN_MARKER_VALUE;
    return { stored: ours ? token : null, userSet: !ours && token !== null };
  } catch {
    return { stored: null, userSet: false };
  }
}

function editEnv(text: string, key: string, value: string | undefined): string {
  return applyEdits(text, modify(text, ["env", key], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }));
}

// ---- the marketplace declaration (ahood#1018 step B) ------------------------

/**
 * `extraKnownMarketplaces.ahood` in settings.json, as `claude plugin
 * marketplace add` writes it: `ours` with the declared ref (null = none, so
 * the repo's default branch) when it names this repo on GitHub; `other` when
 * the name points somewhere else (a fork, a local checkout), which setup
 * leaves alone; undefined when nothing is declared.
 */
export type Declaration = { kind: "ours"; ref: string | null; autoUpdate: boolean } | { kind: "other"; source: string } | undefined;

export function declarationOf(settings: Record<string, unknown>): Declaration {
  const all = settings.extraKnownMarketplaces;
  if (all === null || typeof all !== "object" || Array.isArray(all)) return undefined;
  const entry = (all as Record<string, unknown>)[CLAUDE_MARKETPLACE_NAME] as { source?: unknown; autoUpdate?: unknown } | undefined;
  if (entry === undefined || entry === null || typeof entry !== "object") return undefined;
  const source = (entry.source ?? {}) as { source?: unknown; repo?: unknown; ref?: unknown; url?: unknown; path?: unknown };
  if (source.source === "github" && typeof source.repo === "string" && source.repo.toLowerCase() === CLAUDE_MARKETPLACE_REPO.toLowerCase()) {
    return { kind: "ours", ref: typeof source.ref === "string" ? source.ref : null, autoUpdate: entry.autoUpdate === true };
  }
  const where = [source.source, source.repo ?? source.url ?? source.path].filter((v) => typeof v === "string").join(" ");
  return { kind: "other", source: where || JSON.stringify(entry.source) };
}

function settingsDeclaration(): Declaration {
  try {
    return declarationOf(readSettings().value);
  } catch {
    return undefined;
  }
}

const describeRef = (ref: string | null) => (ref === null ? "unpinned (the repo's default branch, unreleased commits included)" : ref);

function editSettings(text: string, path: string[], value: unknown): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { tabSize: 2, insertSpaces: true } }));
}

/**
 * Adds a settings.json edit to the one FileChange setup makes to that file
 * (the token and the declaration share it), or starts that change.
 */
function withSettingsEdit(change: FileChange | null, before: string | null, edit: (text: string) => string, what: string): FileChange {
  const base = change?.after ?? before ?? "{}\n";
  let after = edit(base);
  if (!after.endsWith("\n")) after += "\n";
  if (change) return { ...change, after, what: change.before === change.after ? what : `${change.what}; ${what}` };
  return { path: settingsPath(), before, after, what };
}

/** Store (token) or take out (null) setup's own env.AHOOD_TOKEN; a value the user set is never touched. */
function planSettingsToken(token: string | null): FileChange | null {
  const path = settingsPath();
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings();
  } catch (error) {
    // Not storing anything: a settings.json we cannot read holds no token of ours to take out.
    if (token === null) return null;
    throw error;
  }
  const { text, env } = read;
  const ours = env[CLAUDE_TOKEN_MARKER_KEY] === CLAUDE_TOKEN_MARKER_VALUE;
  const current = typeof env[CLAUDE_TOKEN_ENV_KEY] === "string" ? (env[CLAUDE_TOKEN_ENV_KEY] as string) : null;
  if (!ours && current !== null) return null; // the user's own
  const secrets = [ours ? current : null, token].filter((t): t is string => t !== null);
  if (token === null) {
    if (!ours || text === null) return null;
    let after = editEnv(editEnv(text, CLAUDE_TOKEN_ENV_KEY, undefined), CLAUDE_TOKEN_MARKER_KEY, undefined);
    const left = (parse(after) as { env?: object }).env;
    if (left && Object.keys(left).length === 0) after = applyEdits(after, modify(after, ["env"], undefined, {}));
    return { path, before: text, after, what: `env.${CLAUDE_TOKEN_ENV_KEY} (stored by ahood setup) removed`, secrets };
  }
  if (ours && current === token) return { path, before: text, after: text, what: `env.${CLAUDE_TOKEN_ENV_KEY}`, secrets };
  let after = editEnv(editEnv(text ?? "{}\n", CLAUDE_TOKEN_ENV_KEY, token), CLAUDE_TOKEN_MARKER_KEY, CLAUDE_TOKEN_MARKER_VALUE);
  if (!after.endsWith("\n")) after += "\n";
  return { path, before: text, after, what: `env.${CLAUDE_TOKEN_ENV_KEY}: your ahood token, for the plugin's MCP server`, secrets };
}

// ---- auto-update (ahood#1018 step C) ---------------------------------------

const AUTO_UPDATE_PATH = ["extraKnownMarketplaces", CLAUDE_MARKETPLACE_NAME, "autoUpdate"];
const AUTO_UPDATE_ON = `extraKnownMarketplaces.${CLAUDE_MARKETPLACE_NAME}.autoUpdate: true -- Claude Code updates the plugin in the background`;
const AUTO_UPDATE_BY_HAND = `/plugin -> Marketplaces -> ${CLAUDE_MARKETPLACE_NAME} -> Enable auto-update`;
export const CLAUDE_AUTO_UPDATE_QUESTION = "Keep ahood up to date automatically? [Y/n] ";

const setAutoUpdate = (on: boolean) => (text: string) => editSettings(text, AUTO_UPDATE_PATH, on ? true : undefined);

/** Turns `autoUpdate` on in settings.json as the claude CLI left it; nothing when there is no declaration to put it on. */
function deferredAutoUpdate(): DeferredChange {
  return {
    path: settingsPath(),
    what: AUTO_UPDATE_ON,
    plan: () => {
      const { text, value } = readSettings();
      const declared = declarationOf(value);
      if (text === null || declared?.kind !== "ours" || declared.autoUpdate) return null;
      return withSettingsEdit(null, text, setAutoUpdate(true), AUTO_UPDATE_ON);
    },
  };
}

function autoUpdateEnabled(): boolean {
  const declared = settingsDeclaration();
  return declared?.kind === "ours" && declared.autoUpdate;
}

function planSetup(opts: SetupOptions): SetupPlan {
  if (opts.releaseBranch === false) throw new SetupRefusedError(releaseBranchMissing("Claude Code"));
  const plan = emptyPlan();
  let settingsChange = planSettingsToken(opts.token);
  const { text, value } = readSettings();
  const declared = declarationOf(value);
  if (declared?.kind === "other") {
    throw new SetupRefusedError(
      `${displayPath(settingsPath())} already declares the "${CLAUDE_MARKETPLACE_NAME}" marketplace from ${declared.source} -- leaving your entry alone. ` +
        `Remove it (\`claude plugin marketplace remove ${CLAUDE_MARKETPLACE_NAME}\`) and re-run to install from ${CLAUDE_MARKETPLACE_SOURCE}; nothing was changed.`,
    );
  }
  // An install from before the release channel (unpinned = `main`, or a tag):
  // the declaration moves to the release branch first, then `marketplace add`
  // re-clones at it -- `add` refuses any source but the declared one.
  const migrate = declared?.kind === "ours" && declared.ref !== CLAUDE_MARKETPLACE_REF;
  if (migrate) {
    settingsChange = withSettingsEdit(
      settingsChange,
      text,
      (t) => editSettings(t, ["extraKnownMarketplaces", CLAUDE_MARKETPLACE_NAME, "source", "ref"], CLAUDE_MARKETPLACE_REF),
      `extraKnownMarketplaces.${CLAUDE_MARKETPLACE_NAME}: marketplace moved from ${describeRef(declared.ref)} to the ${CLAUDE_MARKETPLACE_REF} branch`,
    );
  }
  // Background updates (ahood#1018 step C): on with the user's consent, and
  // kept on when they were on already -- `marketplace add` drops the field.
  const wantAutoUpdate = opts.autoUpdate || (declared?.kind === "ours" && declared.autoUpdate);
  // Straight into the declaration when there is one that stays; a migration's
  // `add` rewrites it, so then the deferred change below sets it instead.
  const autoUpdateHere = wantAutoUpdate && declared?.kind === "ours" && !declared.autoUpdate && !migrate;
  if (autoUpdateHere) settingsChange = withSettingsEdit(settingsChange, text, setAutoUpdate(true), AUTO_UPDATE_ON);
  const { binary } = detect();
  const cli = binary !== null && claudeSupportsPluginCli(binary);
  if (!cli) {
    if (settingsChange) plan.files.push(settingsChange);
    plan.notes.push(binary ? "this claude CLI has no `plugin` subcommands." : "the claude CLI is not on PATH.");
    plan.manual.push(...CLAUDE_IN_SESSION_INSTALL);
    if (wantAutoUpdate && declared === undefined) {
      plan.notes.push(`once it is installed, re-run \`ahood setup claude\` to turn on auto-update (or ${AUTO_UPDATE_BY_HAND}).`);
    }
    return plan;
  }
  const listed = listedMarketplace(binary!);
  // Listed at another ref without a user-settings declaration (one from an
  // older claude, or another scope): `add` at the release branch moves it.
  const listedElsewhere = listed !== null && declared === undefined && (listed.ref ?? null) !== CLAUDE_MARKETPLACE_REF;
  const installed = pluginInstalled(binary!);
  if (settingsChange) plan.files.push(settingsChange);
  if (installed && !migrate && !listedElsewhere && listed !== null) {
    plan.notes.push(
      `${CLAUDE_PLUGIN_ID} is already installed from the ${CLAUDE_MARKETPLACE_REF} branch; Claude Code updates it with \`claude plugin update ${CLAUDE_PLUGIN_ID}\`.`,
    );
    return plan;
  }
  if (migrate || listedElsewhere || listed === null) {
    plan.commands.push({
      bin: binary!,
      args: [...CLAUDE_INSTALL_ARGS.marketplaceAdd],
      what: `add the ahood plugin marketplace from the ${CLAUDE_MARKETPLACE_REF} branch`,
    });
    // `add` rewrites the declaration without `autoUpdate` (verified, claude
    // 2.1.282), so it is set once the commands are done, on the file as
    // `add` left it.
    if (wantAutoUpdate) plan.afterCommands.push(deferredAutoUpdate());
  }
  plan.commands.push(
    installed
      ? { bin: binary!, args: [...CLAUDE_INSTALL_ARGS.pluginUpdate], what: `update the ahood plugin from the ${CLAUDE_MARKETPLACE_REF} branch` }
      : { bin: binary!, args: [...CLAUDE_INSTALL_ARGS.pluginInstall], what: "install the ahood plugin" },
  );
  return plan;
}

function planRemove(): SetupPlan {
  const plan = emptyPlan();
  let settingsChange = planSettingsToken(null);
  const { binary } = detect();
  const cli = binary !== null && claudeSupportsPluginCli(binary);
  const removesDeclaration = cli && marketplaceAdded(binary!);
  // `marketplace remove` deletes the whole declaration, autoUpdate with it;
  // without it, setup takes its own `autoUpdate: true` back out (ahood#1018 step C).
  if (!removesDeclaration && autoUpdateEnabled()) {
    const { text } = readSettings();
    settingsChange = withSettingsEdit(
      settingsChange,
      text,
      setAutoUpdate(false),
      `extraKnownMarketplaces.${CLAUDE_MARKETPLACE_NAME}.autoUpdate removed`,
    );
  }
  if (settingsChange) plan.files.push(settingsChange);
  if (!cli) {
    plan.notes.push(binary ? "this claude CLI has no `plugin` subcommands." : "the claude CLI is not on PATH.");
    plan.manual.push(...CLAUDE_IN_SESSION_REMOVE);
    return plan;
  }
  if (pluginInstalled(binary)) {
    plan.commands.push({ bin: binary!, args: [...CLAUDE_REMOVE_ARGS.pluginUninstall], what: "uninstall the ahood plugin" });
  }
  if (removesDeclaration) {
    plan.commands.push({ bin: binary!, args: [...CLAUDE_REMOVE_ARGS.marketplaceRemove], what: "remove the ahood plugin marketplace" });
  }
  if (plan.commands.length === 0 && plan.files.length === 0) plan.notes.push("the ahood plugin is not installed; nothing to remove.");
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
  const state = { ...inspectPlugin(), tokenStored: settingsTokenState().stored !== null };
  const channel = channelFeature();
  if (channel && state.state !== "absent") {
    state.features.push(channel);
    if (channel.state === "stale" && state.state === "ok") state.state = "stale";
  }
  if (state.state !== "absent") state.features.push(autoUpdateFeature());
  return state;
}

/** `auto-update: on|off` (ahood#1018 step C): off is Claude Code's default for a third-party marketplace. */
function autoUpdateFeature(): Feature {
  if (autoUpdateEnabled()) {
    return { name: "auto-update", state: "ok", detail: `on (extraKnownMarketplaces.${CLAUDE_MARKETPLACE_NAME}.autoUpdate in ${displayPath(settingsPath())})` };
  }
  return {
    name: "auto-update",
    state: "stale",
    detail: `off in ${displayPath(settingsPath())} -- new releases arrive only with \`claude plugin update ${CLAUDE_PLUGIN_ID}\`; turn it on: re-run \`ahood setup claude\` (or ${AUTO_UPDATE_BY_HAND})`,
  };
}

/** Which ref Claude Code reads the marketplace from (ahood#1018 step B), per the settings.json declaration. */
function channelFeature(): Feature | null {
  const declared = settingsDeclaration();
  if (declared === undefined) return null;
  if (declared.kind === "other") return { name: "channel", state: "stale", detail: `the "${CLAUDE_MARKETPLACE_NAME}" marketplace is declared from ${declared.source}` };
  if (declared.ref === CLAUDE_MARKETPLACE_REF) {
    return { name: "channel", state: "ok", detail: `${CLAUDE_MARKETPLACE_REF} branch (${CLAUDE_MARKETPLACE_SOURCE})` };
  }
  return {
    name: "channel",
    state: "stale",
    detail: `${describeRef(declared.ref)} -- re-run \`ahood setup claude\` to move to the ${CLAUDE_MARKETPLACE_REF} branch`,
  };
}

function inspectPlugin(): ConfigState {
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

const tokenStore: TokenStore = {
  file: settingsPath,
  stored: () => settingsTokenState().stored,
  userSet: () => settingsTokenState().userSet,
  what: `env.${CLAUDE_TOKEN_ENV_KEY} in Claude Code's settings.json`,
};

export const claudeHarness: Harness = {
  id: "claude",
  label: "Claude Code",
  detect,
  planSetup,
  planRemove,
  inspect,
  tokenStore,
  autoUpdateConsent: { enabled: autoUpdateEnabled, question: CLAUDE_AUTO_UPDATE_QUESTION },
};
