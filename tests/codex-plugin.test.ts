// ahood#1009: the Codex plugin in plugins/codex and its marketplace
// .agents/plugins/marketplace.json -- the committed files are exactly what
// src/setup/templates/codex-plugin.ts renders, and their shapes are the ones
// Codex reads.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AHOOD_COMMANDS } from "../src/setup/templates/ahood-commands.js";
import { CODEX_MARKETPLACE_NAME, CODEX_PLUGIN_ID } from "../src/setup/templates/codex.js";
import { CODEX_MARKETPLACE_FILE, CODEX_PLUGIN_DIR, codexPluginFiles } from "../src/setup/templates/codex-plugin.js";
import { CLI_VERSION } from "../src/version.js";

const ROOT = join(import.meta.dirname, "..");
const PLUGIN = join(ROOT, CODEX_PLUGIN_DIR);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

const manifest = readJson(join(PLUGIN, ".codex-plugin", "plugin.json"));
const marketplace = readJson(join(ROOT, CODEX_MARKETPLACE_FILE));

describe("the committed Codex plugin files", () => {
  it("are exactly what src/setup/templates/codex-plugin.ts renders (run `npm run sync-plugin`)", () => {
    const rendered = codexPluginFiles();
    expect(rendered.length).toBeGreaterThan(0);
    for (const { file, content } of rendered) {
      expect(readFileSync(join(ROOT, file), "utf-8"), file).toBe(content);
    }
  });

  it("the plugin holds nothing the generators do not write", () => {
    const owned = new Set([
      ...codexPluginFiles().map((f) => f.file),
      // scripts/sync-skill.mjs (tests/skill-sync.test.ts guards it).
      `${CODEX_PLUGIN_DIR}/skills/using-ahood/SKILL.md`,
    ]);
    const onDisk = readdirSync(PLUGIN, { recursive: true, encoding: "utf-8" })
      .map((f) => `${CODEX_PLUGIN_DIR}/${f}`)
      .filter((f) => statSync(join(ROOT, f)).isFile());
    expect(onDisk.sort()).toEqual([...owned].filter((f) => f.startsWith(`${CODEX_PLUGIN_DIR}/`)).sort());
  });
});

describe("plugin.json and marketplace.json", () => {
  it("plugin.json names the ahood plugin at the CLI's version, with skills and MCP servers, and no secrets", () => {
    expect(manifest.name).toBe("ahood");
    // Codex caches a plugin per version, so a release that changes the
    // plugin must bump it; tying it to package.json makes that automatic.
    expect(manifest.version).toBe(CLI_VERSION);
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(existsSync(join(PLUGIN, manifest.skills))).toBe(true);
    expect(existsSync(join(PLUGIN, manifest.mcpServers))).toBe(true);
    expect(manifest.interface.displayName).toBe("ahood");
    expect(JSON.stringify(manifest)).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  it("the marketplace lists it under the id setup enables, from a local path in this repo", () => {
    expect(marketplace.name).toBe(CODEX_MARKETPLACE_NAME);
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(`${entry.name}@${marketplace.name}`).toBe(CODEX_PLUGIN_ID);
    expect(CODEX_PLUGIN_ID).toBe("ahood@ahood");
    expect(entry.source).toEqual({ source: "local", path: `./${CODEX_PLUGIN_DIR}` });
    expect(existsSync(join(ROOT, entry.source.path, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  it(".mcp.json points at the hosted server and names the token env var, never a token", () => {
    expect(readJson(join(PLUGIN, ".mcp.json"))).toEqual({
      mcpServers: { ahood: { type: "http", url: "https://www.ahood.dev/api/mcp", bearer_token_env_var: "AHOOD_TOKEN" } },
    });
  });
});

describe("the plugin's skills", () => {
  const skillsDir = join(PLUGIN, "skills");

  it("are `ahood` (the /ahood command set) and `using-ahood` (the self-skill), each named after its folder", () => {
    expect(readdirSync(skillsDir).sort()).toEqual(["ahood", "using-ahood"]);
    for (const name of readdirSync(skillsDir)) {
      expect(readFileSync(join(skillsDir, name, "SKILL.md"), "utf-8")).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    }
  });

  it("the `ahood` skill carries every shared command body verbatim, and no setup-ownership marker", () => {
    const skill = readFileSync(join(skillsDir, "ahood", "SKILL.md"), "utf-8");
    for (const c of AHOOD_COMMANDS) expect(skill).toContain(c.body);
    // The plugin is Codex's to install and remove, not `ahood setup`'s.
    expect(skill).not.toContain("ahood setup --remove codex");
  });
});

// The authoritative check is Codex itself: add this repo as a local
// marketplace in a throwaway CODEX_HOME, install the plugin, and read back
// what Codex lists. Runs only when a codex CLI is on PATH (CI has none).
const codex = spawnSync("codex", ["--version"], { encoding: "utf-8" });
describe.skipIf(codex.status !== 0)("installs with the real codex CLI", () => {
  it("`codex plugin add ahood@ahood` installs it at this version, with its MCP server", () => {
    const home = mkdtempSync(join(tmpdir(), "ahood-codex-plugin-"));
    const run = (...args: string[]) => {
      const result = spawnSync("codex", args, { encoding: "utf-8", env: { ...process.env, CODEX_HOME: home } });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      run("plugin", "marketplace", "add", ROOT);
      run("plugin", "add", CODEX_PLUGIN_ID);
      expect(run("plugin", "list")).toMatch(new RegExp(`${CODEX_PLUGIN_ID}\\s+installed, enabled\\s+${CLI_VERSION.replace(/\./g, "\\.")}`));
      expect(run("mcp", "list")).toMatch(/ahood\s+https:\/\/www\.ahood\.dev\/api\/mcp\s+AHOOD_TOKEN/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
