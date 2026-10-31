// ahood#981: the Claude Code plugin in plugins/ahood -- manifest shapes, the
// generated /ahood command files, and their front matter.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AHOOD_CLI, AHOOD_COMMANDS } from "../src/setup/templates/ahood-commands.js";
import { CLI_VERSION } from "../src/version.js";
import {
  CLAUDE_AHOOD_VERBS,
  CLAUDE_COMMAND_ALLOWED_TOOLS,
  CLAUDE_PLUGIN_DIR,
  claudePluginCommandFiles,
  claudePluginManifest,
} from "../src/setup/templates/claude-plugin.js";
import { CLAUDE_MARKETPLACE_NAME, CLAUDE_PLUGIN_ID } from "../src/setup/templates/claude.js";

const ROOT = join(import.meta.dirname, "..");
const PLUGIN = join(ROOT, CLAUDE_PLUGIN_DIR);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

const manifest = readJson(join(PLUGIN, ".claude-plugin", "plugin.json"));
const marketplace = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
const entry = marketplace.plugins.find((p: { name: string }) => p.name === manifest.name);

/** The front matter this repo writes: `key: value` lines and `key:` + `  - item` lists. */
function frontMatter(file: string): { fields: Record<string, string | string[]>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(file, "utf-8"));
  if (!match) throw new Error(`${file} has no front matter`);
  const fields: Record<string, string | string[]> = {};
  let list: string[] | null = null;
  for (const line of match[1].split("\n")) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (item && list) {
      list.push(item[1]);
      continue;
    }
    const kv = /^([a-z-]+):(?: (.*))?$/.exec(line);
    if (!kv) throw new Error(`${file}: unparsed front matter line ${JSON.stringify(line)}`);
    if (kv[2] === undefined) fields[kv[1]] = list = [];
    else {
      list = null;
      fields[kv[1]] = kv[2].startsWith('"') ? JSON.parse(kv[2]) : kv[2];
    }
  }
  return { fields, body: match[2] };
}

describe("plugin manifest and marketplace", () => {
  it("plugin.json names the ahood plugin with a semver version and no secrets", () => {
    expect(manifest.name).toBe("ahood");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description).toEqual(expect.any(String));
    expect(manifest.author.name).toEqual(expect.any(String));
    expect(JSON.stringify(manifest)).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  it("plugin.json is generated at the CLI's version (ahood#1018: one version, never hand-bumped)", () => {
    expect(manifest.version).toBe(CLI_VERSION);
    expect(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8")).toBe(claudePluginManifest());
  });

  it("the marketplace lists it under the id setup installs, with no version of its own", () => {
    expect(marketplace.name).toBe(CLAUDE_MARKETPLACE_NAME);
    expect(`${entry.name}@${marketplace.name}`).toBe(CLAUDE_PLUGIN_ID);
    // plugin.json carries the version (ahood#1018); one set in both places
    // can only disagree, and plugin.json wins silently when it does.
    expect(entry).not.toHaveProperty("version");
    expect(entry.source).toBe(`./${CLAUDE_PLUGIN_DIR}`);
    expect(existsSync(join(ROOT, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it(".mcp.json points at the hosted server and names the token env var, never a token", () => {
    const mcp = readJson(join(PLUGIN, ".mcp.json"));
    expect(mcp.ahood).toEqual({
      type: "http",
      url: "https://www.ahood.dev/api/mcp",
      headers: { Authorization: "Bearer ${AHOOD_TOKEN}" },
    });
  });

  // The authoritative schema check is Claude Code's own validator; run it
  // when a claude CLI is on PATH (CI has none, so it is skipped there).
  const claude = spawnSync("claude", ["--version"], { encoding: "utf-8" });
  it.skipIf(claude.status !== 0)("passes `claude plugin validate --strict` (plugin and marketplace)", () => {
    for (const target of [ROOT, PLUGIN]) {
      const result = spawnSync("claude", ["plugin", "validate", "--strict", "--json", target], { encoding: "utf-8" });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).success).toBe(true);
    }
  });
});

describe("/ahood command files", () => {
  const commandsDir = join(PLUGIN, "commands");

  it("are exactly what src/setup/templates/claude-plugin.ts renders (run `npm run sync-plugin`)", () => {
    const rendered = claudePluginCommandFiles();
    expect(readdirSync(commandsDir).sort()).toEqual(rendered.map((f) => f.file.replace("commands/", "")).sort());
    for (const { file, content } of rendered) {
      expect(readFileSync(join(PLUGIN, file), "utf-8"), file).toBe(content);
    }
  });

  it("there is one per shared command: the /ahood hub and its thirteen verbs (ahood#1019)", () => {
    expect(readdirSync(commandsDir).sort()).toEqual(
      [
        "ahood.md",
        "ahood-find.md",
        "ahood-trending.md",
        "ahood-try.md",
        "ahood-install.md",
        "ahood-prompt.md",
        "ahood-loop.md",
        "ahood-project.md",
        "ahood-star.md",
        "ahood-publish.md",
        "ahood-stats.md",
        "ahood-sync.md",
        "ahood-review.md",
        "ahood-snap.md",
      ].sort(),
    );
    expect(Object.keys(CLAUDE_COMMAND_ALLOWED_TOOLS).sort()).toEqual(AHOOD_COMMANDS.map((c) => c.name).sort());
  });

  for (const c of AHOOD_COMMANDS) {
    describe(`${c.name}.md`, () => {
      const { fields, body } = frontMatter(join(commandsDir, `${c.name}.md`));

      it("has only front matter keys Claude Code reads for commands", () => {
        for (const key of Object.keys(fields)) {
          expect(["description", "argument-hint", "allowed-tools", "disable-model-invocation"]).toContain(key);
        }
        expect(fields.description).toBe(c.description);
        expect(fields["disable-model-invocation"]).toBe("true");
      });

      it("pre-approves only read-only `ahood` calls -- nothing that syncs, approves, rejects, pins or saves", () => {
        const allowed = (fields["allowed-tools"] ?? []) as string[];
        expect(Array.isArray(allowed)).toBe(true);
        for (const tool of allowed) {
          // The same pinned CLI the body runs (ahood#1018), or the grant never matches.
          expect(tool.startsWith(`Bash(npx -y @ahood/cli@${CLI_VERSION} `)).toBe(true);
          expect(tool).toMatch(/^Bash\([^()]+\)$/);
          expect(tool).not.toMatch(/--yes|\bapprove\b|\breject\b|\bpin\b|snap create|sync \*|sync <|@\S+ \*/);
        }
      });

      it("runs the CLI as `npx -y @ahood/cli@<plugin version>`, never a bare `ahood` on PATH (ahood#1018)", () => {
        expect(AHOOD_CLI).toBe(`npx -y @ahood/cli@${CLI_VERSION}`);
        expect(body).toContain(`\`npx -y @ahood/cli@${CLI_VERSION} `);
        // A bare `ahood <verb>` in backticks would run whatever is on PATH.
        expect(body).not.toMatch(/`ahood (status|sync|skill|pin|review|snap|login|find|try|stats|prompt|project|loop|agent|mcp|doc)\b/);
      });

      it("never tells the agent to pass --yes except for updates the user approved", () => {
        for (const line of body.split("\n").filter((l) => l.includes("--yes"))) {
          expect(line).toMatch(/only for the ones they approved/);
        }
      });
    });
  }

  it("/ahood routes `/ahood <verb>` to the matching steps", () => {
    const { fields, body } = frontMatter(join(commandsDir, "ahood.md"));
    const verbs = ["find", "trending", "try", "install", "prompt", "loop", "project", "star", "publish", "stats", "sync", "review", "snap"];
    expect(fields["argument-hint"]).toBe(`[${verbs.join("|")}]`);
    expect(CLAUDE_AHOOD_VERBS).toEqual(verbs);
    expect(body).toContain("`/ahood $ARGUMENTS`");
    for (const verb of CLAUDE_AHOOD_VERBS) expect(body).toContain(`\n## ${verb}\n`);
    expect(body).toContain(`${AHOOD_CLI} status --json`);
    expect(body).toContain(`${AHOOD_CLI} review approve <id>`);
    expect(body).toContain(`${AHOOD_CLI} snap create`);
  });
});
