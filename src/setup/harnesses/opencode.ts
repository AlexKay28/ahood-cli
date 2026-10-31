// opencode (ahood#980, ahood#1009): the ahood MCP server at mcp.servers.ahood
// and @ahood/opencode-plugin in the `plugins` array of the global
// opencode.json(c), edited with jsonc-parser so the user's comments and
// formatting survive. The plugin brings the /ahood commands, so the command
// files setup wrote before ahood#1009 are taken out (with the usual backups).
// Formats and locations: templates/opencode.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parse, parseTree, printParseErrorCode, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { SetupRefusedError } from "../errors.js";
import { OWNED_MARKER, planOwnedFileRemoval, readIfExists, type FileChange } from "../file-changes.js";
import { displayPath, opencodeConfigDir } from "../paths.js";
import { runner } from "../runner.js";
import { AHOOD_MCP_URL } from "../templates/ahood-commands.js";
import { OPENCODE_PLUGIN_PACKAGE } from "../templates/opencode-plugin.js";
import {
  OPENCODE_CONFIG_FILES,
  OPENCODE_MCP_PATH,
  OPENCODE_PLUGINS_KEY,
  opencodeCommandFiles,
  opencodeMcpEntry,
  opencodeStoredToken,
} from "../templates/opencode.js";
import { emptyPlan, type ConfigState, type Detection, type Feature, type Harness, type SetupOptions, type SetupPlan, type TokenStore } from "./types.js";

// Written by setup before ahood#1009; now only ever removed.
const legacyCommandPath = (file: string) => join(opencodeConfigDir(), "commands", file);

/** Same choice `opencode mcp add --global` makes: the first config file that exists, else opencode.json. */
function configPath(): string {
  const dir = opencodeConfigDir();
  const existing = OPENCODE_CONFIG_FILES.map((f) => join(dir, f)).find((p) => existsSync(p));
  return existing ?? join(dir, OPENCODE_CONFIG_FILES[0]);
}

function detect(): Detection {
  const binary = runner().which("opencode");
  const configDir = opencodeConfigDir();
  const configDirExists = existsSync(configDir);
  return { binary, configDir, configDirExists, installed: binary !== null || configDirExists };
}

/** opencode before v2 keeps MCP servers under a different key; writing ours there would not work. */
function refuseOldOpencode(): void {
  const { binary } = detect();
  if (!binary) return;
  const out = runner().run(binary, ["--version"]);
  const major = /v?(\d+)\.\d+/.exec(`${out.stdout} ${out.stderr}`)?.[1];
  if (major !== undefined && Number(major) < 2) {
    throw new SetupRefusedError(
      `opencode ${out.stdout.trim()} is older than v2, whose config layout setup targets. Upgrade opencode (opencode upgrade) and re-run; nothing was changed.`,
    );
  }
}

function parseOrRefuse(text: string, path: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new SetupRefusedError(
      `${displayPath(path)} is not valid JSON (${printParseErrorCode(first.error)} at offset ${first.offset}). Fix it first; nothing was changed.`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SetupRefusedError(`${displayPath(path)} is not a JSON object. Fix it first; nothing was changed.`);
  }
  return value;
}

function entryAt(value: unknown): unknown {
  let node: unknown = value;
  for (const key of OPENCODE_MCP_PATH) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** An `ahood` entry pointing at ahood's MCP URL is ours; anything else under that name is the user's. */
function isOurs(entry: unknown): boolean {
  return entry !== null && typeof entry === "object" && (entry as { url?: unknown }).url === AHOOD_MCP_URL;
}

function sameEntry(entry: unknown, token: string | null): boolean {
  return JSON.stringify(entry) === JSON.stringify(opencodeMcpEntry(token));
}

/** The token setup stored in our entry, or null. */
function storedToken(): string | null {
  const path = configPath();
  const text = readIfExists(path);
  if (text === null) return null;
  try {
    const entry = entryAt(parseOrRefuse(text, path));
    return isOurs(entry) ? opencodeStoredToken(entry) : null;
  } catch {
    return null;
  }
}

const FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } };

function edit(text: string, path: Array<string | number>, value: unknown, isArrayInsertion = false): string {
  return applyEdits(text, modify(text, path, value, { ...FORMAT, isArrayInsertion }));
}

/** A `plugins` item naming our package: the bare name, or `{ package, options }` (@opencode/schema config/plugin.d.ts). */
function namesOurPlugin(item: unknown): boolean {
  if (item === OPENCODE_PLUGIN_PACKAGE) return true;
  return item !== null && typeof item === "object" && (item as { package?: unknown }).package === OPENCODE_PLUGIN_PACKAGE;
}

function pluginsOf(value: unknown, path: string): unknown[] | undefined {
  const plugins = (value as Record<string, unknown>)[OPENCODE_PLUGINS_KEY];
  if (plugins === undefined) return undefined;
  if (!Array.isArray(plugins)) {
    throw new SetupRefusedError(`${displayPath(path)} has a \`${OPENCODE_PLUGINS_KEY}\` that is not a list. Fix it first; nothing was changed.`);
  }
  return plugins;
}

function hasOurPlugin(value: unknown, path: string): boolean {
  return (pluginsOf(value, path) ?? []).some(namesOurPlugin);
}

function pluginsNode(text: string): JsonNode | undefined {
  const tree = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  return tree && findNodeAtLocation(tree, [OPENCODE_PLUGINS_KEY]);
}

/**
 * Appends our package to `plugins` (creating the list if there is none),
 * unless any form of it is there already. Into an existing list it is spliced
 * in as text right after the last item -- jsonc-parser's own array insertion
 * would reflow the user's list -- so removePlugin can cut exactly that out.
 */
function addPlugin(text: string, path: string): string {
  const plugins = pluginsOf(parseOrRefuse(text, path), path);
  if (plugins === undefined) return edit(text, [OPENCODE_PLUGINS_KEY], [OPENCODE_PLUGIN_PACKAGE]);
  if (plugins.some(namesOurPlugin)) return text;
  const list = pluginsNode(text)!;
  const last = list.children?.at(-1);
  const name = JSON.stringify(OPENCODE_PLUGIN_PACKAGE);
  return last
    ? applyEdits(text, [{ offset: last.offset + last.length, length: 0, content: `, ${name}` }])
    : applyEdits(text, [{ offset: list.offset + 1, length: 0, content: name }]);
}

/** Takes out every `plugins` item naming our package with the comma before it, and the list itself once nothing else is in it. */
function removePlugin(text: string, path: string): string {
  let after = text;
  for (;;) {
    const items = pluginsNode(after)?.children ?? [];
    const index = items.findIndex((item) => namesOurPlugin(getNodeValue(item)));
    if (index === -1) break;
    const item = items[index];
    const [from, to] =
      index > 0
        ? [items[index - 1].offset + items[index - 1].length, item.offset + item.length]
        : index + 1 < items.length
          ? [item.offset, items[index + 1].offset]
          : [item.offset, item.offset + item.length];
    after = applyEdits(after, [{ offset: from, length: to - from, content: "" }]);
  }
  const left = pluginsOf(parseOrRefuse(after, path), path);
  return left !== undefined && left.length === 0 && after !== text ? edit(after, [OPENCODE_PLUGINS_KEY], undefined) : after;
}

/** Removes our MCP entry, and the `servers` / `mcp` objects it leaves empty. */
function removeEntry(text: string, path: string): string {
  let after = edit(text, [...OPENCODE_MCP_PATH], undefined);
  for (let depth = OPENCODE_MCP_PATH.length - 1; depth > 0; depth--) {
    const parent = OPENCODE_MCP_PATH.slice(0, depth);
    let node: unknown = parseOrRefuse(after, path);
    for (const key of parent) node = (node as Record<string, unknown>)[key];
    if (node === null || typeof node !== "object" || Object.keys(node).length > 0) break;
    after = edit(after, [...parent], undefined);
  }
  return after;
}

function planConfig(remove: boolean, token: string | null = null): FileChange | null {
  const path = configPath();
  const before = readIfExists(path);
  const value = before === null ? undefined : parseOrRefuse(before, path);
  const entry = value === undefined ? undefined : entryAt(value);
  const listed = value !== undefined && hasOurPlugin(value, path);
  const previous = isOurs(entry) ? opencodeStoredToken(entry) : null;
  const secrets = [previous, token].filter((t): t is string => t !== null);
  if (remove) {
    if (before === null) return null;
    let after = before;
    if (isOurs(entry)) after = removeEntry(after, path);
    if (listed) after = removePlugin(after, path);
    if (after === before) return null;
    const what = [isOurs(entry) && (previous ? "ahood MCP server entry and stored token" : "ahood MCP server entry"), listed && OPENCODE_PLUGIN_PACKAGE]
      .filter(Boolean)
      .join(" and ");
    return { path, before, after, what: `${what} removed`, secrets };
  }
  if (entry !== undefined && !isOurs(entry)) {
    throw new SetupRefusedError(
      `${displayPath(path)} already has an mcp.servers.ahood entry that does not point at ${AHOOD_MCP_URL} -- leaving your ` +
        "entry alone. Delete it and re-run to let setup manage it; nothing was changed.",
    );
  }
  let after = before ?? "{}\n";
  if (entry === undefined || !sameEntry(entry, token)) after = edit(after, [...OPENCODE_MCP_PATH], opencodeMcpEntry(token));
  after = addPlugin(after, path);
  if (!after.endsWith("\n")) after += "\n";
  const result = parseOrRefuse(after, path);
  if (!sameEntry(entryAt(result), token) || !hasOurPlugin(result, path)) {
    throw new SetupRefusedError(`Adding ahood to ${displayPath(path)} would not yield a working config; nothing was changed.`);
  }
  if (before !== null && after === before) return { path, before, after: before, what: `MCP server "ahood" and plugin ${OPENCODE_PLUGIN_PACKAGE}`, secrets };
  return {
    path,
    before,
    after,
    what: `MCP server "ahood" (${AHOOD_MCP_URL})${token ? ", with your ahood token" : ""}, and plugin ${OPENCODE_PLUGIN_PACKAGE}`,
    secrets,
  };
}

/** The command files setup wrote before ahood#1009: deleted when ours (backed up if edited), left with a note when not. */
function planLegacyCommandRemoval(plan: SetupPlan): void {
  for (const { file, content } of opencodeCommandFiles()) {
    const change = planOwnedFileRemoval(legacyCommandPath(file), content, `/${file.replace(/\.md$/, "")} command file (the plugin brings it now)`, plan.notes);
    if (change) plan.files.push(change);
  }
}

function planSetup(opts: SetupOptions): SetupPlan {
  refuseOldOpencode();
  const plan = emptyPlan();
  plan.files.push(planConfig(false, opts.token)!);
  planLegacyCommandRemoval(plan);
  plan.notes.push(
    `opencode installs ${OPENCODE_PLUGIN_PACKAGE} from npm when it next starts; it brings the /ahood commands. ` +
      "If npm does not have it, opencode skips it without an error -- `ahood doctor` checks.",
  );
  return plan;
}

function planRemove(): SetupPlan {
  const plan = emptyPlan();
  const config = planConfig(true);
  if (config) plan.files.push(config);
  planLegacyCommandRemoval(plan);
  return plan;
}

function inspect(): ConfigState {
  const path = configPath();
  const text = readIfExists(path);
  let mcp: "ok" | "stale" | "absent" = "absent";
  let plugin: "ok" | "absent" = "absent";
  if (text !== null) {
    try {
      const value = parseOrRefuse(text, path);
      const entry = entryAt(value);
      if (isOurs(entry)) mcp = sameEntry(entry, opencodeStoredToken(entry)) ? "ok" : "stale";
      if (hasOurPlugin(value, path)) plugin = "ok";
    } catch (error) {
      return { state: "broken", details: [error instanceof Error ? error.message : String(error)], features: [] };
    }
  }
  const legacy = opencodeCommandFiles().filter(({ file }) => readIfExists(legacyCommandPath(file))?.includes(OWNED_MARKER));
  const commandsDir = join(opencodeConfigDir(), "commands");
  const details = [
    `MCP entry in ${displayPath(path)}: ${mcp}`,
    `${OPENCODE_PLUGIN_PACKAGE} in its ${OPENCODE_PLUGINS_KEY}: ${plugin === "ok" ? "listed" : "absent"}`,
  ];
  const features: Feature[] = [
    { name: "MCP config", state: mcp, detail: displayPath(path) },
    { name: "plugin", state: plugin, detail: `${OPENCODE_PLUGIN_PACKAGE} in ${OPENCODE_PLUGINS_KEY} of ${displayPath(path)}` },
  ];
  // ahood#1018 step C: opencode re-checks a plugin named without a version
  // for a newer one on npm when it starts; an exact version never moves.
  // Setup lists the bare name, and only that (or `{ package }`) counts as ours.
  if (plugin === "ok") {
    features.push({ name: "auto-update", state: "ok", detail: `on (the bare ${OPENCODE_PLUGIN_PACKAGE} is updated from npm when opencode starts)` });
  }
  if (legacy.length > 0) {
    details.push(`${legacy.length} command file(s) from an earlier setup in ${displayPath(commandsDir)}`);
    features.push({ name: "old command files", state: "stale", detail: `${displayPath(commandsDir)} -- re-run \`ahood setup opencode\` to take them out` });
  }
  const tokenStored = storedToken() !== null;
  if (mcp === "absent" && plugin === "absent" && legacy.length === 0) return { state: "absent", details, features };
  if (mcp === "absent" || plugin === "absent") return { state: "partial", details, features, tokenStored };
  if (mcp === "stale" || legacy.length > 0) return { state: "stale", details, features, tokenStored };
  return { state: "ok", details, features, tokenStored };
}

const tokenStore: TokenStore = {
  file: configPath,
  stored: storedToken,
  userSet: () => false, // an mcp.servers.ahood of the user's own is refused outright (planConfig)
  what: "the ahood MCP entry in opencode.json",
};

export const opencodeHarness: Harness = {
  id: "opencode",
  label: "opencode",
  detect,
  planSetup,
  planRemove,
  inspect,
  tokenStore,
  npmPackage: OPENCODE_PLUGIN_PACKAGE,
};
