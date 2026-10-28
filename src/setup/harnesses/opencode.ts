// opencode (ahood#980): the ahood MCP server at mcp.servers.ahood in the
// global opencode.json(c), edited with jsonc-parser so the user's comments and
// formatting survive, plus one markdown command file per `/ahood` command.
// Formats and locations: templates/opencode.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { SetupRefusedError } from "../errors.js";
import { planOwnedFile, planOwnedFileRemoval, readIfExists, type FileChange } from "../file-changes.js";
import { displayPath, opencodeConfigDir } from "../paths.js";
import { runner } from "../runner.js";
import { AHOOD_MCP_URL } from "../templates/ahood-commands.js";
import { OPENCODE_CONFIG_FILES, OPENCODE_MCP_PATH, opencodeCommandFiles, opencodeMcpEntry } from "../templates/opencode.js";
import { emptyPlan, type ConfigState, type Detection, type Harness, type SetupPlan } from "./types.js";

const commandPath = (file: string) => join(opencodeConfigDir(), "commands", file);

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

function sameEntry(entry: unknown): boolean {
  return JSON.stringify(entry) === JSON.stringify(opencodeMcpEntry());
}

function edit(text: string, value: unknown): string {
  const edits = modify(text, [...OPENCODE_MCP_PATH], value, { formattingOptions: { tabSize: 2, insertSpaces: true } });
  return applyEdits(text, edits);
}

function planConfig(remove: boolean): FileChange | null {
  const path = configPath();
  const before = readIfExists(path);
  const entry = before === null ? undefined : entryAt(parseOrRefuse(before, path));
  if (remove) {
    if (entry === undefined) return null;
    if (!isOurs(entry)) return null;
    return { path, before, after: edit(before!, undefined), what: "ahood MCP server entry removed" };
  }
  if (entry !== undefined && !isOurs(entry)) {
    throw new SetupRefusedError(
      `${displayPath(path)} already has an mcp.servers.ahood entry that does not point at ${AHOOD_MCP_URL} -- leaving your ` +
        "entry alone. Delete it and re-run to let setup manage it; nothing was changed.",
    );
  }
  if (entry !== undefined && sameEntry(entry)) return { path, before, after: before, what: "MCP server \"ahood\"" };
  const base = before ?? "{}\n";
  let after = edit(base, opencodeMcpEntry());
  if (!after.endsWith("\n")) after += "\n";
  if (!sameEntry(entryAt(parseOrRefuse(after, path)))) {
    throw new SetupRefusedError(`Adding the ahood entry to ${displayPath(path)} would not yield a working entry; nothing was changed.`);
  }
  return { path, before, after, what: `MCP server "ahood" (${AHOOD_MCP_URL})` };
}

function planSetup(): SetupPlan {
  refuseOldOpencode();
  const plan = emptyPlan();
  plan.files.push(planConfig(false)!);
  for (const { file, content } of opencodeCommandFiles()) {
    plan.files.push(planOwnedFile(commandPath(file), content, `/${file.replace(/\.md$/, "")} command`));
  }
  return plan;
}

function planRemove(): SetupPlan {
  const plan = emptyPlan();
  const config = planConfig(true);
  if (config) plan.files.push(config);
  for (const { file, content } of opencodeCommandFiles()) {
    const change = planOwnedFileRemoval(commandPath(file), content, `/${file.replace(/\.md$/, "")} command`, plan.notes);
    if (change) plan.files.push(change);
  }
  return plan;
}

function inspect(): ConfigState {
  const path = configPath();
  const text = readIfExists(path);
  let mcp: "ok" | "stale" | "absent" = "absent";
  if (text !== null) {
    let entry: unknown;
    try {
      entry = entryAt(parseOrRefuse(text, path));
    } catch (error) {
      return { state: "broken", details: [error instanceof Error ? error.message : String(error)] };
    }
    if (isOurs(entry)) mcp = sameEntry(entry) ? "ok" : "stale";
  }
  const files = opencodeCommandFiles();
  const present = files.filter(({ file }) => readIfExists(commandPath(file)) !== null);
  const current = files.filter(({ file, content }) => readIfExists(commandPath(file)) === content);
  const commands = present.length === 0 ? "absent" : current.length === files.length ? "ok" : present.length === files.length ? "stale" : "partial";
  const details = [`MCP entry in ${displayPath(path)}: ${mcp}`, `commands in ${displayPath(join(opencodeConfigDir(), "commands"))}: ${commands}`];
  if (mcp === "absent" && commands === "absent") return { state: "absent", details };
  if (mcp === "absent" || commands === "absent" || commands === "partial") return { state: "partial", details };
  if (mcp === "stale" || commands === "stale") return { state: "stale", details };
  return { state: "ok", details };
}

export const opencodeHarness: Harness = { id: "opencode", label: "opencode", detect, planSetup, planRemove, inspect };
