// Codex (ahood#980): the ahood MCP server as a marked block in
// $CODEX_HOME/config.toml, the `/ahood` command set as the `ahood` skill, and
// an AGENTS.md snippet (appended to $CODEX_HOME/AGENTS.md only with --yes).
// Formats and locations: templates/codex.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { SetupRefusedError } from "../errors.js";
import { planOwnedFile, planOwnedFileRemoval, readIfExists, type FileChange } from "../file-changes.js";
import { hasBlock, readBlock, removeBlock, upsertBlock } from "../marked-block.js";
import { codexHome, displayPath } from "../paths.js";
import { runner } from "../runner.js";
import { AHOOD_MCP_URL } from "../templates/ahood-commands.js";
import {
  agentsSnippetBody,
  agentsSnippetFile,
  CODEX_AGENTS_MARKERS,
  CODEX_MCP_SERVER_NAME,
  CODEX_TOML_MARKERS,
  codexMcpBlock,
  codexSkill,
} from "../templates/codex.js";
import { emptyPlan, type ConfigState, type Detection, type Harness, type SetupOptions, type SetupPlan } from "./types.js";

const configPath = () => join(codexHome(), "config.toml");
const skillPath = () => join(codexHome(), "skills", "ahood", "SKILL.md");
const snippetPath = () => join(codexHome(), "ahood-agents-snippet.md");
const agentsPath = () => join(codexHome(), "AGENTS.md");

function detect(): Detection {
  const binary = runner().which("codex");
  const configDir = codexHome();
  const configDirExists = existsSync(configDir);
  return { binary, configDir, configDirExists, installed: binary !== null || configDirExists };
}

type ParsedToml = { mcp_servers?: Record<string, { url?: unknown }> };

function parseOrRefuse(text: string, path: string, when: string): ParsedToml {
  try {
    return parseToml(text) as ParsedToml;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const subject = when ? `${displayPath(path)} ${when}` : displayPath(path);
    throw new SetupRefusedError(`${subject} is not valid TOML (${reason}). Fix it first; nothing was changed.`);
  }
}

function planConfig(remove: boolean): FileChange | null {
  const path = configPath();
  const before = readIfExists(path);
  const parsed = parseOrRefuse(before ?? "", path, "");
  const ours = before !== null && hasBlock(before, CODEX_TOML_MARKERS, displayPath(path));
  if (remove) {
    if (!ours) return null;
    const after = removeBlock(before!, CODEX_TOML_MARKERS, displayPath(path));
    parseOrRefuse(after, path, "without the ahood block");
    return { path, before, after: after.trim() === "" ? null : after, what: "ahood MCP server entry removed" };
  }
  if (!ours && parsed.mcp_servers?.[CODEX_MCP_SERVER_NAME] !== undefined) {
    throw new SetupRefusedError(
      `${displayPath(path)} already defines [mcp_servers.${CODEX_MCP_SERVER_NAME}] outside ahood's managed block -- ` +
        "leaving your entry alone. Delete it and re-run to let setup manage it; nothing was changed.",
    );
  }
  const after = upsertBlock(before ?? "", codexMcpBlock(), CODEX_TOML_MARKERS, displayPath(path));
  const check = parseOrRefuse(after, path, "with the ahood block added");
  if (check.mcp_servers?.[CODEX_MCP_SERVER_NAME]?.url !== AHOOD_MCP_URL) {
    throw new SetupRefusedError(`Adding the ahood block to ${displayPath(path)} would not yield a working entry; nothing was changed.`);
  }
  return { path, before, after, what: `MCP server "${CODEX_MCP_SERVER_NAME}" (${AHOOD_MCP_URL})` };
}

function planAgents(remove: boolean): FileChange | null {
  const path = agentsPath();
  const before = readIfExists(path);
  if (before === null) return remove ? null : { path, before, after: upsertBlock("", agentsSnippetBody(), CODEX_AGENTS_MARKERS, path), what: "ahood snippet" };
  if (remove) {
    if (!hasBlock(before, CODEX_AGENTS_MARKERS, displayPath(path))) return null;
    const after = removeBlock(before, CODEX_AGENTS_MARKERS, displayPath(path));
    return { path, before, after: after.trim() === "" ? null : after, what: "ahood snippet removed" };
  }
  return { path, before, after: upsertBlock(before, agentsSnippetBody(), CODEX_AGENTS_MARKERS, displayPath(path)), what: "ahood snippet" };
}

function planSetup(opts: SetupOptions): SetupPlan {
  const plan = emptyPlan();
  plan.files.push(planConfig(false)!);
  plan.files.push(planOwnedFile(skillPath(), codexSkill(), "`ahood` skill (call it as $ahood, or pick it from /skills)"));
  plan.files.push(planOwnedFile(snippetPath(), agentsSnippetFile(), "AGENTS.md snippet to paste where you want it"));
  if (opts.yes) {
    plan.files.push(planAgents(false)!);
  } else {
    plan.notes.push(`${displayPath(agentsPath())} is not edited without --yes; the snippet is in ${displayPath(snippetPath())}.`);
  }
  return plan;
}

function planRemove(): SetupPlan {
  const plan = emptyPlan();
  for (const change of [
    planConfig(true),
    planOwnedFileRemoval(skillPath(), codexSkill(), "`ahood` skill", plan.notes),
    planOwnedFileRemoval(snippetPath(), agentsSnippetFile(), "AGENTS.md snippet", plan.notes),
    planAgents(true),
  ]) {
    if (change) plan.files.push(change);
  }
  return plan;
}

function inspect(): ConfigState {
  const path = configPath();
  const text = readIfExists(path);
  let mcp: "ok" | "stale" | "absent" = "absent";
  if (text !== null) {
    let block: string | null;
    try {
      parseToml(text);
      block = readBlock(text, CODEX_TOML_MARKERS, displayPath(path));
    } catch (error) {
      return { state: "broken", details: [`${displayPath(path)}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`] };
    }
    if (block !== null) mcp = block === `${CODEX_TOML_MARKERS.begin}\n${codexMcpBlock()}\n${CODEX_TOML_MARKERS.end}` ? "ok" : "stale";
  }
  const skill = readIfExists(skillPath());
  const skillState = skill === null ? "absent" : skill === codexSkill() ? "ok" : "stale";
  const details = [`MCP entry in ${displayPath(path)}: ${mcp}`, `skill ${displayPath(skillPath())}: ${skillState}`];
  if (mcp === "absent" && skillState === "absent") return { state: "absent", details };
  if (mcp === "absent" || skillState === "absent") return { state: "partial", details };
  if (mcp === "stale" || skillState === "stale") return { state: "stale", details };
  return { state: "ok", details };
}

export const codexHarness: Harness = { id: "codex", label: "Codex", detect, planSetup, planRemove, inspect };
