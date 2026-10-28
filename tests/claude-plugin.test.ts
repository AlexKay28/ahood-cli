// ahood#981: the Claude Code plugin in plugins/ahood -- manifest shapes, the
// generated /ahood command files, and their front matter.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AHOOD_COMMANDS } from "../src/setup/templates/ahood-commands.js";
import {
  CLAUDE_AHOOD_VERBS,
  CLAUDE_COMMAND_ALLOWED_TOOLS,
  CLAUDE_PLUGIN_DIR,
  claudePluginCommandFiles,
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

  it("the marketplace lists it under the id setup installs, at the same version", () => {
    expect(marketplace.name).toBe(CLAUDE_MARKETPLACE_NAME);
    expect(`${entry.name}@${marketplace.name}`).toBe(CLAUDE_PLUGIN_ID);
    // `claude plugin tag` refuses a release where these disagree.
    expect(entry.version).toBe(manifest.version);
    expect(entry.source).toBe(`./${CLAUDE_PLUGIN_DIR}`);
    expect(existsSync(join(ROOT, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it(".mcp.json points at the hosted server and names the token env var, never a token", () => {
    const mcp = readJson(join(PLUGIN, ".mcp.json"));
    expect(mcp.ahood).toEqual({
      type: "http",
      url: "https://www.ahood.dev/api/mcp",
      headers: { Authorization: "Bearer ${AHOOD_API_TOKEN}" },
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

  it("there is one per shared command: /ahood, /ahood-sync, /ahood-review, /ahood-snap", () => {
    expect(readdirSync(commandsDir).sort()).toEqual(["ahood-review.md", "ahood-snap.md", "ahood-sync.md", "ahood.md"]);
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
          expect(tool).toMatch(/^Bash\(ahood [^()]+\)$/);
          expect(tool).not.toMatch(/--yes|\bapprove\b|\breject\b|\bpin\b|snap create|sync \*|sync <|ahood \*/);
        }
      });

      it("never tells the agent to pass --yes except for updates the user approved", () => {
        for (const line of body.split("\n").filter((l) => l.includes("--yes"))) {
          expect(line).toMatch(/only for the ones they approved/);
        }
      });
    });
  }

  it("/ahood routes `/ahood sync|review|snap` to the matching steps", () => {
    const { fields, body } = frontMatter(join(commandsDir, "ahood.md"));
    expect(fields["argument-hint"]).toBe("[sync|review|snap]");
    expect(CLAUDE_AHOOD_VERBS).toEqual(["sync", "review", "snap"]);
    expect(body).toContain("`/ahood $ARGUMENTS`");
    for (const verb of CLAUDE_AHOOD_VERBS) expect(body).toContain(`\n## ${verb}\n`);
    expect(body).toContain("ahood status --json");
    expect(body).toContain("ahood review approve <id>");
    expect(body).toContain("ahood snap create");
  });
});
