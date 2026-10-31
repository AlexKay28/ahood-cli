import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";

vi.mock("../src/confirm.js", async (orig) => ({
  ...(await orig<typeof import("../src/confirm.js")>()),
  isInteractive: vi.fn(() => false),
  confirmYesNo: vi.fn(async () => true),
  askLine: vi.fn(async () => ""),
}));

// `ahood setup` offers `ahood login` when no token is found (ahood#990); never run the real device flow here.
vi.mock("../src/commands/login.js", () => ({ login: vi.fn(async () => {}) }));

import { askLine, confirmYesNo, isInteractive } from "../src/confirm.js";
import { setup } from "../src/setup/setup-command.js";
import { UsageError } from "../src/usage-error.js";
import { writeBackup } from "../src/setup/file-changes.js";
import { upsertBlock } from "../src/setup/marked-block.js";
import { setReleaseProbeForTests } from "../src/setup/release-channel.js";
import {
  agentsSnippetBody,
  agentsSnippetFile,
  CODEX_AGENTS_MARKERS,
  CODEX_MARKETPLACE_REF,
  CODEX_TOML_MARKERS,
  codexMcpBlock,
  codexPluginBlock,
  codexSkill,
} from "../src/setup/templates/codex.js";
import { opencodeCommandFiles } from "../src/setup/templates/opencode.js";
import { CLI_VERSION } from "../src/version.js";
import { captureConsole } from "./helpers/me-env.js";
import { fakeClaude, fakeCodex, fakeOpencode, fakeRunner, listFiles, setupHomeEnv } from "./helpers/harness-env.js";

const MCP_URL = "https://www.ahood.dev/api/mcp";
const backups = (files: string[]) => files.filter((f) => f.includes(".ahood-backup-"));

let env: ReturnType<typeof setupHomeEnv>;
let io: ReturnType<typeof captureConsole>;
let runner: ReturnType<typeof fakeRunner>;

beforeEach(() => {
  env = setupHomeEnv();
  io = captureConsole();
  runner = fakeRunner({});
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.mocked(confirmYesNo).mockResolvedValue(true);
});
afterEach(() => {
  runner.restore();
  env.restore();
});

describe("ahood setup codex (ahood#980, ahood#1009: the Codex plugin)", () => {
  const codex = () => join(env.home, ".codex");
  const config = () => join(codex(), "config.toml");
  const USER_TOML = 'model = "o3"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  const PLUGIN_TOML = {
    marketplaces: { ahood: { source_type: "git", source: "https://github.com/AlexKay28/ahood-cli.git", ref: "release" } },
    plugins: { "ahood@ahood": { enabled: true } },
  };
  /** The codex commands setup ran, without its read-only probes. */
  const codexRuns = () =>
    runner.calls.filter((c) => c.bin === "codex" && !c.args.includes("--help") && !c.args.includes("--json")).map((c) => c.args.join(" "));
  let cx: ReturnType<typeof fakeCodex>;

  beforeEach(() => {
    runner.restore();
    cx = fakeCodex();
    runner = fakeRunner({ codex: cx.bin });
  });

  it("fresh install: only the marketplace and the enabled plugin in config.toml, then Codex fetches and installs it", async () => {
    await setup(["codex", "--yes"]);
    expect(parseToml(readFileSync(config(), "utf-8"))).toEqual(PLUGIN_TOML);
    expect(readFileSync(config(), "utf-8")).toContain(codexPluginBlock());
    // No MCP entry, skill file or AGENTS.md snippet of setup's own any more: the plugin brings them.
    expect(listFiles(codex())).toEqual(["config.toml"]);
    expect(codexRuns()).toEqual(["plugin marketplace upgrade ahood", "plugin add ahood@ahood"]);
    expect(cx.state.installed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("keeps the user's TOML byte-for-byte and backs the file up before editing", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    await setup(["codex", "--yes"]);
    const toml = readFileSync(config(), "utf-8");
    expect(toml.startsWith(USER_TOML)).toBe(true);
    expect(toml).toContain(codexPluginBlock());
    const [backup] = backups(listFiles(codex()));
    expect(readFileSync(join(codex(), backup), "utf-8")).toBe(USER_TOML);
  });

  it("re-run is idempotent: no duplicate block, no new backup, nothing rewritten, no codex command", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    await setup(["codex", "--yes"]);
    const first = listFiles(codex());
    const content = readFileSync(config(), "utf-8");
    runner.calls.length = 0;
    await setup(["codex", "--yes"]);
    expect(listFiles(codex())).toEqual(first);
    expect(readFileSync(config(), "utf-8")).toBe(content);
    expect(content.match(/\[marketplaces\.ahood\]/g)).toHaveLength(1);
    expect(codexRuns()).toEqual([]);
    expect(io.stdout()).toContain("Already set up; nothing to change.");
    expect(io.stdout()).toContain("ahood@ahood is already installed");
  });

  it("--remove leaves config.toml byte-identical to before setup, and uninstalls through codex", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    writeFileSync(join(codex(), "AGENTS.md"), "# mine\n");
    await setup(["codex", "--yes"]);
    runner.calls.length = 0;
    await setup(["--remove", "codex", "--yes"]);
    expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    expect(readFileSync(join(codex(), "AGENTS.md"), "utf-8")).toBe("# mine\n");
    expect(codexRuns()).toEqual(["plugin remove ahood@ahood", "plugin marketplace remove ahood"]);
    expect(cx.state).toMatchObject({ installed: false, cloned: false });
    expect(backups(listFiles(codex())).length).toBeGreaterThanOrEqual(2);
    // and a second remove has nothing left to do
    await setup(["--remove", "codex", "--yes"]);
    expect(io.stdout()).toContain("Nothing of ahood's to remove.");
  });

  it("--remove of a marketplace Codex never cloned runs no codex command that would fail", async () => {
    runner.restore();
    runner = fakeRunner({ codex: fakeCodex().bin }); // upgrade never ran
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), upsertBlock(USER_TOML, codexPluginBlock(), CODEX_TOML_MARKERS, config()));
    await setup(["--remove", "codex", "--yes"]);
    expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    expect(codexRuns()).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  describe("the marketplace tracks the release branch (ahood#1018 step B; replaces ahood#1009's tag pin)", () => {
    const REF_LINE = `ref = "release"`;
    /** The block an earlier setup wrote: unpinned (no `ref`), or pinned to a tag (ahood#1009). */
    const blockWithRef = (ref: string | null) =>
      codexPluginBlock()
        .split("\n")
        .flatMap((line) => (line === REF_LINE ? (ref === null ? [] : [`ref = ${JSON.stringify(ref)}`]) : [line]))
        .join("\n");
    const writeEarlierBlock = (ref: string | null) => {
      mkdirSync(codex(), { recursive: true });
      writeFileSync(config(), upsertBlock(USER_TOML, blockWithRef(ref), CODEX_TOML_MARKERS, config()));
    };

    it('writes `ref = "release"` right after `source`, the way `codex plugin marketplace add --ref` does', async () => {
      expect(CODEX_MARKETPLACE_REF).toBe("release");
      await setup(["codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toContain(
        `[marketplaces.ahood]\nsource_type = "git"\nsource = "https://github.com/AlexKay28/ahood-cli.git"\n${REF_LINE}\n`,
      );
      expect(io.stdout()).toContain("(https://github.com/AlexKay28/ahood-cli.git at release)");
    });

    for (const [label, ref] of [
      ["an unpinned block", null],
      ["a block pinned to a release tag (ahood#1009)", `v${CLI_VERSION}`],
      ["a block pinned to an older tag", "v0.0.1"],
    ] as const) {
      it(`migrates ${label}: rewrites it with the ref, backs it up, and re-checks the installed plugin out with \`marketplace upgrade\` only`, async () => {
        writeEarlierBlock(ref);
        const before = readFileSync(config(), "utf-8");
        runner.restore();
        cx = fakeCodex({ cloned: true, installed: true });
        runner = fakeRunner({ codex: cx.bin });
        await setup(["codex", "--yes"]);
        expect(parseToml(readFileSync(config(), "utf-8"))).toEqual({ ...(parseToml(USER_TOML) as object), ...PLUGIN_TOML });
        expect(readFileSync(config(), "utf-8").match(/^ref = /gm)).toHaveLength(1);
        const [backup] = backups(listFiles(codex()));
        expect(readFileSync(join(codex(), backup), "utf-8")).toBe(before);
        expect(io.stdout()).toContain(`marketplace re-pinned from ${ref ?? "unpinned (the repo's default branch)"}`);
        expect(codexRuns()).toEqual(["plugin marketplace upgrade ahood"]);
        // and a re-run has nothing left to do
        runner.calls.length = 0;
        await setup(["codex", "--yes"]);
        expect(codexRuns()).toEqual([]);
        expect(io.stdout()).toContain("ahood@ahood is already installed from the release branch");
      });
    }

    it("refuses, changing nothing, while GitHub has no release branch yet", async () => {
      writeEarlierBlock(`v${CLI_VERSION}`);
      const before = readFileSync(config(), "utf-8");
      const restore = setReleaseProbeForTests(async () => false);
      try {
        await setup(["codex", "--yes"]);
      } finally {
        restore();
      }
      expect(process.exitCode).toBe(1);
      expect(io.stderr()).toMatch(/Codex: refused -- the `release` branch of AlexKay28\/ahood-cli does not exist yet/);
      expect(readFileSync(config(), "utf-8")).toBe(before);
      expect(codexRuns()).toEqual([]);
    });

    it("an unpinned block with nothing installed yet gets the ref and the usual fetch + install", async () => {
      writeEarlierBlock(null);
      await setup(["codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toContain(REF_LINE);
      expect(codexRuns()).toEqual(["plugin marketplace upgrade ahood", "plugin add ahood@ahood"]);
    });

    it("--remove after migrating an unpinned block leaves config.toml byte-identical to before ahood", async () => {
      writeEarlierBlock(null);
      await setup(["codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toContain(REF_LINE);
      await setup(["--remove", "codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    });

    it("--remove straight from an unpinned block takes it out byte-identically too", async () => {
      writeEarlierBlock(null);
      await setup(["--remove", "codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    });
  });

  describe("migration from the pre-plugin setup (ahood#1009)", () => {
    /** What `ahood setup codex --yes` left on disk before ahood#1009. */
    function writeOldSetup() {
      mkdirSync(join(codex(), "skills", "ahood"), { recursive: true });
      writeFileSync(config(), upsertBlock(USER_TOML, codexMcpBlock(), CODEX_TOML_MARKERS, config()));
      writeFileSync(join(codex(), "skills", "ahood", "SKILL.md"), codexSkill());
      writeFileSync(join(codex(), "ahood-agents-snippet.md"), agentsSnippetFile());
      writeFileSync(join(codex(), "AGENTS.md"), upsertBlock("# mine\n", agentsSnippetBody(), CODEX_AGENTS_MARKERS, "AGENTS.md"));
    }

    it("one run swaps the old MCP block for the plugin block and removes the skill, snippet file and AGENTS.md snippet", async () => {
      writeOldSetup();
      const oldConfig = readFileSync(config(), "utf-8");
      await setup(["codex", "--yes"]);
      expect(parseToml(readFileSync(config(), "utf-8"))).toEqual({ ...(parseToml(USER_TOML) as object), ...PLUGIN_TOML });
      expect(readFileSync(config(), "utf-8")).not.toContain("[mcp_servers.ahood]");
      expect(existsSync(join(codex(), "skills", "ahood"))).toBe(false);
      expect(existsSync(join(codex(), "ahood-agents-snippet.md"))).toBe(false);
      expect(readFileSync(join(codex(), "AGENTS.md"), "utf-8")).toBe("# mine\n");
      // The usual backups: the edited config.toml and AGENTS.md (the skill and snippet are regenerable, so none).
      const made = backups(listFiles(codex()));
      expect(made.filter((f) => f.startsWith("config.toml.")).map((f) => readFileSync(join(codex(), f), "utf-8"))).toEqual([oldConfig]);
      expect(made.some((f) => f.startsWith("AGENTS.md."))).toBe(true);
      expect(io.stdout()).toContain("the old [mcp_servers.ahood] entry goes");
      expect(codexRuns()).toEqual(["plugin marketplace upgrade ahood", "plugin add ahood@ahood"]);
    });

    it("then --remove leaves config.toml as it was before ahood was ever set up", async () => {
      writeOldSetup();
      await setup(["codex", "--yes"]);
      await setup(["--remove", "codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    });

    it("--remove straight from the old setup takes everything out too", async () => {
      writeOldSetup();
      await setup(["--remove", "codex", "--yes"]);
      expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
      expect(listFiles(codex()).filter((f) => !f.includes(".ahood-backup-"))).toEqual(["AGENTS.md", "config.toml"]);
    });

    it("a SKILL.md of the user's own at the old path is left alone, and no longer blocks setup", async () => {
      mkdirSync(join(codex(), "skills", "ahood"), { recursive: true });
      writeFileSync(join(codex(), "skills", "ahood", "SKILL.md"), "my own skill\n");
      await setup(["codex", "--yes"]);
      expect(readFileSync(join(codex(), "skills", "ahood", "SKILL.md"), "utf-8")).toBe("my own skill\n");
      expect(parseToml(readFileSync(config(), "utf-8"))).toEqual(PLUGIN_TOML);
    });
  });

  it("refuses a malformed config.toml without writing or running anything", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), "model = \n[[[broken");
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toMatch(/config\.toml is not valid TOML .*nothing was changed/);
    expect(listFiles(codex())).toEqual(["config.toml"]);
    expect(codexRuns()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  for (const [table, toml] of [
    ["[mcp_servers.ahood]", '[mcp_servers.ahood]\nurl = "https://example.test/mcp"\n'],
    ["[marketplaces.ahood]", '[marketplaces.ahood]\nsource_type = "git"\nsource = "https://github.com/AlexKay28/ahood-cli.git"\n'],
    ['[plugins."ahood@ahood"]', '[plugins."ahood@ahood"]\nenabled = false\n'],
  ]) {
    it(`refuses when the user already has their own ${table}`, async () => {
      mkdirSync(codex(), { recursive: true });
      writeFileSync(config(), toml);
      await setup(["codex", "--yes"]);
      expect(io.stderr()).toContain(`already defines ${table} outside ahood's managed block`);
      expect(readFileSync(config(), "utf-8")).toBe(toml);
      expect(process.exitCode).toBe(1);
    });
  }

  it("refuses a damaged ahood block (begin marker without end)", async () => {
    mkdirSync(codex(), { recursive: true });
    const damaged = "# >>> ahood (managed by `ahood setup codex`; remove with `ahood setup --remove codex`) >>>\n";
    writeFileSync(config(), damaged);
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toMatch(/damaged ahood block/);
    expect(readFileSync(config(), "utf-8")).toBe(damaged);
  });

  it("--dry-run prints the plan, including the codex commands, and writes or runs nothing", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    await setup(["codex", "--yes", "--dry-run"]);
    expect(listFiles(codex())).toEqual(["config.toml"]);
    expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    expect(codexRuns()).toEqual([]);
    expect(io.stdout()).toContain("would update");
    expect(io.stdout()).toContain("would run    codex plugin add ahood@ahood -- install the ahood plugin");
    expect(io.stdout()).toContain("Nothing was changed (--dry-run).");
  });

  it("no codex CLI on PATH: writes the block and says which two commands install the plugin", async () => {
    runner.restore();
    runner = fakeRunner({});
    mkdirSync(codex(), { recursive: true });
    await setup(["codex", "--yes"]);
    expect(parseToml(readFileSync(config(), "utf-8"))).toEqual(PLUGIN_TOML);
    expect(io.stdout()).toContain("the codex CLI is not on PATH");
    expect(io.stdout()).toContain("`codex plugin marketplace upgrade ahood` and `codex plugin add ahood@ahood`");
  });

  it("a codex CLI without `plugin` subcommands: the same, and says to update Codex", async () => {
    runner.restore();
    runner = fakeRunner({ codex: fakeCodex({ supportsPlugins: false }).bin });
    await setup(["codex", "--yes"]);
    expect(existsSync(config())).toBe(true);
    expect(codexRuns()).toEqual([]);
    expect(io.stdout()).toContain("no `plugin` subcommands (update Codex)");
  });

  it("a failing `codex plugin add` fails the run (exit 1) after the block is written", async () => {
    runner.restore();
    runner = fakeRunner({ codex: fakeCodex({ failAdd: true }).bin });
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toContain("could not install the ahood plugin");
    expect(process.exitCode).toBe(1);
  });

  it("a declined prompt changes nothing and runs nothing", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(confirmYesNo).mockResolvedValue(false);
    await setup(["codex"]);
    expect(listFiles(env.home)).toEqual([]);
    expect(codexRuns()).toEqual([]);
  });

  it("without a terminal or --yes, refuses (exit 2) and writes nothing", async () => {
    await expect(setup(["codex"])).rejects.toThrow(UsageError);
    expect(listFiles(env.home)).toEqual([]);
  });

  it("honours CODEX_HOME", async () => {
    const custom = join(env.home, "elsewhere");
    process.env.CODEX_HOME = custom;
    await setup(["codex", "--yes"]);
    expect(existsSync(join(custom, "config.toml"))).toBe(true);
    expect(existsSync(join(env.home, ".codex"))).toBe(false);
  });
});

describe("ahood setup opencode (ahood#980, ahood#1009: the opencode plugin)", () => {
  const dir = () => join(env.home, ".config", "opencode");
  const commandsDir = () => join(dir(), "commands");
  const entryOf = (text: string) => (parseJsonc(text) as { mcp?: { servers?: Record<string, unknown> } }).mcp?.servers?.ahood;
  const pluginsOf = (text: string) => (parseJsonc(text) as { plugins?: unknown[] }).plugins;
  const PLUGIN = "@ahood/opencode-plugin";
  /** What setup wrote before ahood#1009: the MCP entry plus one command file per /ahood command. */
  const writeLegacySetup = (configText: string) => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.json"), configText);
    for (const { file, content } of opencodeCommandFiles()) writeFileSync(join(commandsDir(), file), content);
  };
  const JSONC = '{\n  // my comment\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark",\n}\n';

  beforeEach(() => {
    runner.restore();
    runner = fakeRunner({ opencode: fakeOpencode() });
  });

  it("fresh install: opencode.json with mcp.servers.ahood and the plugin in `plugins`; no command files", async () => {
    await setup(["opencode", "--yes"]);
    const config = readFileSync(join(dir(), "opencode.json"), "utf-8");
    expect(entryOf(config)).toEqual({ type: "remote", url: MCP_URL, headers: { Authorization: "Bearer {env:AHOOD_TOKEN}" } });
    expect(pluginsOf(config)).toEqual([PLUGIN]);
    expect(listFiles(dir())).toEqual(["opencode.json"]);
    expect(io.stdout()).toMatch(/opencode installs @ahood\/opencode-plugin from npm/);
  });

  it("appends to the user's own plugins and keeps them; an existing entry for ours (bare or { package }) is not duplicated", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.json"), '{\n  "plugins": ["their-plugin"]\n}\n');
    await setup(["opencode", "--yes"]);
    expect(pluginsOf(readFileSync(join(dir(), "opencode.json"), "utf-8"))).toEqual(["their-plugin", PLUGIN]);
    writeFileSync(join(dir(), "opencode.json"), JSON.stringify({ plugins: [{ package: PLUGIN, options: {} }] }));
    await setup(["opencode", "--yes"]);
    expect(pluginsOf(readFileSync(join(dir(), "opencode.json"), "utf-8"))).toEqual([{ package: PLUGIN, options: {} }]);
  });

  it("refuses a `plugins` that is not a list", async () => {
    mkdirSync(dir(), { recursive: true });
    const mine = '{"plugins":"x"}';
    writeFileSync(join(dir(), "opencode.json"), mine);
    await setup(["opencode", "--yes"]);
    expect(io.stderr()).toMatch(/`plugins` that is not a list/);
    expect(readFileSync(join(dir(), "opencode.json"), "utf-8")).toBe(mine);
  });

  it("migrates a setup from before ahood#1009: adds the plugin, deletes the unedited command files without backups", async () => {
    writeLegacySetup(JSON.stringify({ mcp: { servers: { ahood: { type: "remote", url: MCP_URL, headers: { Authorization: "Bearer {env:AHOOD_TOKEN}" } } } } }));
    await setup(["opencode", "--yes"]);
    expect(pluginsOf(readFileSync(join(dir(), "opencode.json"), "utf-8"))).toEqual([PLUGIN]);
    expect(existsSync(commandsDir())).toBe(false);
    expect(listFiles(dir()).filter((f) => f.startsWith("commands"))).toEqual([]);
  });

  it("migration: an edited command file is backed up before it goes; a user's own same-named file is left with a note", async () => {
    writeLegacySetup("{}\n");
    const [first, second] = opencodeCommandFiles();
    writeFileSync(join(commandsDir(), first.file), first.content + "my edit\n");
    writeFileSync(join(commandsDir(), second.file), "---\ndescription: mine\n---\nmine\n");
    await setup(["opencode", "--yes"]);
    const left = listFiles(commandsDir());
    expect(left).toContain(second.file);
    const [backup] = backups(left);
    expect(backup.startsWith(`${first.file}.ahood-backup-`)).toBe(true);
    expect(readFileSync(join(commandsDir(), backup), "utf-8")).toBe(first.content + "my edit\n");
    expect(left.sort()).toEqual([backup, second.file].sort());
    expect(io.stdout()).toMatch(/not written by `ahood setup`/);
  });

  it("--remove leaves opencode.jsonc byte-identical to before setup", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.jsonc"), JSONC);
    await setup(["opencode", "--yes"]);
    await setup(["--remove", "opencode", "--yes"]);
    expect(readFileSync(join(dir(), "opencode.jsonc"), "utf-8")).toBe(JSONC);
    // The user's own list stays on one line (the plugin is spliced in as text); their other server is
    // formatted the way jsonc-parser formats (it reflows an inline sibling when adding ours -- ahood#980 behaviour).
    const theirs =
      '{\n  "plugins": ["their-plugin", { "package": "other", "options": {} }],\n  "mcp": {\n    "servers": {\n      "x": {\n        "type": "remote",\n        "url": "https://x.example"\n      }\n    }\n  }\n}\n';
    writeFileSync(join(dir(), "opencode.jsonc"), theirs);
    chmodSync(join(dir(), "opencode.jsonc"), 0o600); // a world-readable file only gets the token on a separate yes
    process.env.AHOOD_TOKEN = "tok_byte_identical";
    await setup(["opencode", "--yes", "--store-token"]);
    expect(readFileSync(join(dir(), "opencode.jsonc"), "utf-8")).toContain("Bearer tok_byte_identical");
    await setup(["--remove", "opencode", "--yes"]);
    expect(readFileSync(join(dir(), "opencode.jsonc"), "utf-8")).toBe(theirs);
  });

  it("edits an existing opencode.jsonc in place, keeping comments and other keys, with a backup", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.jsonc"), JSONC);
    await setup(["opencode", "--yes"]);
    const text = readFileSync(join(dir(), "opencode.jsonc"), "utf-8");
    expect(text).toContain("// my comment");
    expect(text).toContain('"theme": "dark"');
    expect(entryOf(text)).toMatchObject({ url: MCP_URL });
    expect(existsSync(join(dir(), "opencode.json"))).toBe(false);
    const [backup] = backups(listFiles(dir()));
    expect(readFileSync(join(dir(), backup), "utf-8")).toBe(JSONC);
  });

  it("re-run is idempotent", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.jsonc"), JSONC);
    await setup(["opencode", "--yes"]);
    const first = listFiles(dir());
    const text = readFileSync(join(dir(), "opencode.jsonc"), "utf-8");
    await setup(["opencode", "--yes"]);
    expect(listFiles(dir())).toEqual(first);
    expect(readFileSync(join(dir(), "opencode.jsonc"), "utf-8")).toBe(text);
  });

  it("--remove drops only our entry and our command files", async () => {
    mkdirSync(commandsDir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.jsonc"), JSONC);
    writeFileSync(join(commandsDir(), "mine.md"), "---\ndescription: mine\n---\nhi\n");
    await setup(["opencode", "--yes"]);
    await setup(["--remove", "opencode", "--yes"]);
    const text = readFileSync(join(dir(), "opencode.jsonc"), "utf-8");
    expect(entryOf(text)).toBeUndefined();
    expect(pluginsOf(text)).toBeUndefined();
    expect(text).toContain("// my comment");
    expect(text).toContain('"theme": "dark"');
    expect(listFiles(commandsDir())).toEqual(["mine.md"]);
    expect(backups(listFiles(dir())).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses malformed JSON", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "opencode.json"), '{ "mcp": ');
    await setup(["opencode", "--yes"]);
    expect(io.stderr()).toMatch(/opencode\.json is not valid JSON/);
    expect(listFiles(dir())).toEqual(["opencode.json"]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a user's own mcp.servers.ahood pointing elsewhere", async () => {
    mkdirSync(dir(), { recursive: true });
    const mine = '{"mcp":{"servers":{"ahood":{"type":"local","command":["x"]}}}}';
    writeFileSync(join(dir(), "opencode.json"), mine);
    await setup(["opencode", "--yes"]);
    expect(io.stderr()).toMatch(/already has an mcp\.servers\.ahood entry/);
    expect(readFileSync(join(dir(), "opencode.json"), "utf-8")).toBe(mine);
  });

  it("--dry-run writes nothing", async () => {
    await setup(["opencode", "--dry-run"]);
    expect(listFiles(env.home)).toEqual([]);
    expect(io.stdout()).toContain("would create");
  });

  it("refuses opencode older than v2 (different MCP layout)", async () => {
    runner.restore();
    runner = fakeRunner({ opencode: fakeOpencode("1.4.0") });
    await setup(["opencode", "--yes"]);
    expect(io.stderr()).toMatch(/older than v2/);
    expect(listFiles(env.home)).toEqual([]);
  });
});

describe("ahood setup claude (ahood#980)", () => {
  const mutating = () => runner.calls.filter((c) => !c.args.includes("--help") && !c.args.includes("--json")).map((c) => c.args.join(" "));
  const settings = () => join(env.home, ".claude", "settings.json");
  const writeSettings = (value: unknown) => {
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    writeFileSync(settings(), `${JSON.stringify(value, null, 2)}\n`);
  };
  const declared = (ref?: string) => ({ source: { source: "github", repo: "AlexKay28/ahood-cli", ...(ref ? { ref } : {}) } });

  it("runs marketplace add (from the release branch) + plugin install with --yes, and edits no file itself", async () => {
    const claude = fakeClaude();
    runner.restore();
    runner = fakeRunner({ claude: claude.bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual(["plugin marketplace add AlexKay28/ahood-cli#release", "plugin install ahood@ahood"]);
    expect(claude.state.installed).toBe(true);
    // the only file is the declaration the claude CLI itself wrote (no backup: there was nothing before)
    expect(listFiles(env.home)).toEqual([".claude/settings.json"]);
    // with --yes, auto-update is on (ahood#1018 step C), set after `add` rewrote the declaration
    expect(JSON.parse(readFileSync(settings(), "utf-8")).extraKnownMarketplaces.ahood).toEqual({ ...declared("release"), autoUpdate: true });
  });

  it("is idempotent: an installed plugin runs nothing", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true }).bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual([]);
    expect(io.stdout()).toContain("already installed from the release branch");
  });

  it("skips marketplace add when it is already there", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true }).bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual(["plugin install ahood@ahood"]);
  });

  describe("moves an existing install to the release branch (ahood#1018 step B)", () => {
    for (const [label, ref] of [
      ["an unpinned marketplace (main)", undefined],
      ["a tag-pinned marketplace", "v0.16.0"],
    ] as const) {
      it(`${label}: edits the declaration's ref (backed up), re-adds at release, updates the plugin`, async () => {
        const user = { theme: "dark", extraKnownMarketplaces: { ahood: declared(ref) } };
        writeSettings(user);
        const before = readFileSync(settings(), "utf-8");
        const claude = fakeClaude({ marketplace: true, ref, installed: true });
        runner.restore();
        runner = fakeRunner({ claude: claude.bin });
        await setup(["claude", "--yes"]);
        expect(mutating()).toEqual(["plugin marketplace add AlexKay28/ahood-cli#release", "plugin update ahood@ahood"]);
        expect(io.stdout()).toContain(`marketplace moved from ${ref ?? "unpinned"}`);
        const after = JSON.parse(readFileSync(settings(), "utf-8"));
        expect(after.extraKnownMarketplaces.ahood).toEqual({ ...declared("release"), autoUpdate: true });
        expect(after.theme).toBe("dark");
        const [backup] = backups(listFiles(join(env.home, ".claude"))).sort();
        expect(readFileSync(join(env.home, ".claude", backup), "utf-8")).toBe(before);
        // a re-run has nothing left to do
        runner.calls.length = 0;
        await setup(["claude", "--yes"]);
        expect(mutating()).toEqual([]);
      });
    }

    it("a marketplace listed at another ref with no user-settings declaration is re-added at release", async () => {
      const claude = fakeClaude({ marketplace: true, ref: undefined });
      runner.restore();
      runner = fakeRunner({ claude: claude.bin });
      await setup(["claude", "--yes"]);
      expect(mutating()).toEqual(["plugin marketplace add AlexKay28/ahood-cli#release", "plugin install ahood@ahood"]);
    });

    it("leaves a declaration that points elsewhere (a fork, a local checkout) alone and refuses", async () => {
      writeSettings({ extraKnownMarketplaces: { ahood: { source: { source: "directory", path: "/src/ahood-cli" } } } });
      const before = readFileSync(settings(), "utf-8");
      runner.restore();
      runner = fakeRunner({ claude: fakeClaude().bin });
      await setup(["claude", "--yes"]);
      expect(process.exitCode).toBe(1);
      expect(io.stderr()).toMatch(/already declares the "ahood" marketplace from directory \/src\/ahood-cli/);
      expect(readFileSync(settings(), "utf-8")).toBe(before);
      expect(mutating()).toEqual([]);
    });
  });

  it("refuses, changing nothing, while GitHub has no release branch yet", async () => {
    const restore = setReleaseProbeForTests(async () => false);
    try {
      runner.restore();
      runner = fakeRunner({ claude: fakeClaude().bin });
      await setup(["claude", "--yes"]);
      expect(process.exitCode).toBe(1);
      expect(io.stderr()).toMatch(/`release` branch of AlexKay28\/ahood-cli does not exist yet/);
      expect(io.stderr()).toMatch(/created by the next ahood-cli release/);
      expect(mutating()).toEqual([]);
      expect(listFiles(env.home)).toEqual([]);
    } finally {
      restore();
    }
  });

  it("goes ahead when GitHub could not be asked (the claude CLI then reports a missing ref itself)", async () => {
    const restore = setReleaseProbeForTests(async () => null);
    try {
      runner.restore();
      runner = fakeRunner({ claude: fakeClaude().bin });
      await setup(["claude", "--yes"]);
      expect(mutating()).toEqual(["plugin marketplace add AlexKay28/ahood-cli#release", "plugin install ahood@ahood"]);
    } finally {
      restore();
    }
  });

  it("without `plugin` subcommands, prints the in-session /plugin commands and runs nothing", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ supportsPlugins: false }).bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual([]);
    expect(io.stdout()).toContain("/plugin marketplace add AlexKay28/ahood-cli#release");
    expect(io.stdout()).toContain("/plugin install ahood@ahood");
  });

  it("with no claude on PATH, prints the /plugin commands", async () => {
    await setup(["claude", "--yes"]);
    expect(io.stdout()).toContain("/plugin install ahood@ahood");
    expect(io.stdout()).toMatch(/claude CLI is not on PATH/);
  });

  it("--dry-run lists the commands without running them", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude().bin });
    await setup(["claude", "--dry-run"]);
    expect(mutating()).toEqual([]);
    expect(io.stdout()).toContain("would run    claude plugin marketplace add AlexKay28/ahood-cli#release");
    expect(io.stdout()).toContain("would run    claude plugin install ahood@ahood");
  });

  it("--remove uninstalls the plugin and removes the marketplace (and with it the declaration)", async () => {
    const user = { theme: "dark" };
    writeSettings(user);
    const claude = fakeClaude();
    runner.restore();
    runner = fakeRunner({ claude: claude.bin });
    await setup(["claude", "--yes"]);
    runner.calls.length = 0;
    await setup(["--remove", "claude", "--yes"]);
    expect(mutating()).toEqual(["plugin uninstall ahood@ahood", "plugin marketplace remove ahood"]);
    expect(JSON.parse(readFileSync(settings(), "utf-8"))).toEqual({ ...user, extraKnownMarketplaces: {} });
  });

  it("a failing install exits 1", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ failInstall: true }).bin });
    await setup(["claude", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(io.stderr()).toMatch(/could not install the ahood plugin/);
  });
});

describe("ahood setup claude: auto-update with consent (ahood#1018 step C)", () => {
  const settings = () => join(env.home, ".claude", "settings.json");
  const entry = () => JSON.parse(readFileSync(settings(), "utf-8")).extraKnownMarketplaces?.ahood;
  const writeSettings = (value: unknown) => {
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    writeFileSync(settings(), `${JSON.stringify(value, null, 2)}\n`);
  };
  const ours = { source: { source: "github", repo: "AlexKay28/ahood-cli", ref: "release" } };
  const asked = () => vi.mocked(askLine).mock.calls.map(([q]) => q).filter((q) => q.includes("up to date automatically"));
  let claude: ReturnType<typeof fakeClaude>;
  const useClaude = (state: Parameters<typeof fakeClaude>[0] = {}) => {
    runner.restore();
    claude = fakeClaude(state);
    runner = fakeRunner({ claude: claude.bin });
  };

  it("asks once in a terminal; Enter means yes and autoUpdate lands after `marketplace add` rewrote the entry", async () => {
    useClaude();
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("");
    await setup(["claude"]);
    expect(asked()).toEqual(["\nClaude Code: Keep ahood up to date automatically? [Y/n] "]);
    expect(entry()).toEqual({ ...ours, autoUpdate: true });
    // asked once: on already, a re-run does not ask again
    vi.mocked(askLine).mockClear();
    await setup(["claude"]);
    expect(asked()).toEqual([]);
  });

  it("backs the user's settings.json up before `marketplace add` rewrites it, token redacted", async () => {
    writeSettings({ theme: "dark", env: { AHOOD_TOKEN: "tok-secret", AHOOD_TOKEN_SET_BY: "ahood setup (remove with `ahood setup --remove claude`)" } });
    const before = readFileSync(settings(), "utf-8");
    useClaude();
    await setup(["claude", "--yes", "--store-token"]);
    const found = backups(listFiles(join(env.home, ".claude")));
    expect(found).toHaveLength(1);
    expect(readFileSync(join(env.home, ".claude", found[0]), "utf-8")).toBe(before.replace("tok-secret", "<ahood token removed from this backup>"));
    expect(entry()).toEqual({ ...ours, autoUpdate: true });
  });

  it("a no in the terminal leaves it off", async () => {
    useClaude();
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("n");
    await setup(["claude"]);
    expect(entry()).toEqual(ours);
  });

  it("--no-auto-update neither asks nor writes it", async () => {
    useClaude();
    vi.mocked(isInteractive).mockReturnValue(true);
    await setup(["claude", "--yes", "--no-auto-update"]);
    expect(asked()).toEqual([]);
    expect(entry()).toEqual(ours);
  });

  it("an install that is already on release only gets the flag: a settings edit with a backup, no command", async () => {
    writeSettings({ theme: "dark", extraKnownMarketplaces: { ahood: ours } });
    const before = readFileSync(settings(), "utf-8");
    useClaude({ marketplace: true, installed: true });
    await setup(["claude", "--yes"]);
    expect(runner.calls.filter((c) => !c.args.includes("--help") && !c.args.includes("--json"))).toEqual([]);
    expect(entry()).toEqual({ ...ours, autoUpdate: true });
    const [backup] = backups(listFiles(join(env.home, ".claude")));
    expect(readFileSync(join(env.home, ".claude", backup), "utf-8")).toBe(before);
  });

  it("a migration keeps an autoUpdate the user had on, even with --no-auto-update (`add` would drop it)", async () => {
    writeSettings({ extraKnownMarketplaces: { ahood: { source: { source: "github", repo: "AlexKay28/ahood-cli" }, autoUpdate: true } } });
    useClaude({ marketplace: true, ref: undefined, installed: true });
    await setup(["claude", "--yes", "--no-auto-update"]);
    expect(entry()).toEqual({ ...ours, autoUpdate: true });
  });

  it("--dry-run says the flag is set after the commands, and writes nothing", async () => {
    useClaude();
    await setup(["claude", "--dry-run"]);
    expect(io.stdout()).toContain("then update  ~/.claude/settings.json -- extraKnownMarketplaces.ahood.autoUpdate: true");
    expect(listFiles(env.home)).toEqual([]);
  });

  it("a failed command leaves the flag unwritten", async () => {
    useClaude({ failInstall: true });
    await setup(["claude", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(entry()).toEqual(ours);
  });

  it("--remove with the claude CLI: `marketplace remove` takes the whole entry, autoUpdate included", async () => {
    useClaude();
    await setup(["claude", "--yes"]);
    await setup(["--remove", "claude", "--yes"]);
    expect(entry()).toBeUndefined();
  });

  it("--remove without the claude CLI takes setup's autoUpdate back out, byte-identical to before it", async () => {
    writeSettings({ theme: "dark", extraKnownMarketplaces: { ahood: ours } });
    const before = readFileSync(settings(), "utf-8");
    useClaude({ marketplace: true, installed: true });
    await setup(["claude", "--yes"]);
    expect(entry()).toEqual({ ...ours, autoUpdate: true });
    runner.restore();
    runner = fakeRunner({});
    await setup(["--remove", "claude", "--yes"]);
    expect(readFileSync(settings(), "utf-8")).toBe(before);
  });

  it("--remove with --no-auto-update is a usage error", async () => {
    await expect(setup(["--remove", "claude", "--no-auto-update"])).rejects.toBeInstanceOf(UsageError);
  });
});

describe("backups are never overwritten (ahood#980)", () => {
  it("two backups in the same tick are two distinct files, the original preserved", () => {
    const file = join(env.home, "config.toml");
    writeFileSync(file, "original\n");
    const first = writeBackup(file, "T");
    writeFileSync(file, "edited by setup\n");
    const second = writeBackup(file, "T");
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf-8")).toBe("original\n");
    expect(readFileSync(second, "utf-8")).toBe("edited by setup\n");
    expect(writeBackup(file, "T")).toBe(`${file}.ahood-backup-T-2`);
  });

  it("install then remove within one frozen timestamp keeps the user's original backup", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-28T12:00:00.000Z") });
    try {
      const codex = join(env.home, ".codex");
      mkdirSync(codex, { recursive: true });
      writeFileSync(join(codex, "config.toml"), 'model = "o3"\n');
      await setup(["codex", "--yes"]);
      await setup(["--remove", "codex", "--yes"]);
      const configBackups = backups(listFiles(codex)).filter((f) => f.startsWith("config.toml."));
      expect(configBackups).toHaveLength(2);
      const contents = configBackups.map((f) => readFileSync(join(codex, f), "utf-8"));
      expect(contents).toContain('model = "o3"\n');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ahood setup: harness choice and arguments (ahood#980)", () => {
  it("with no harness detected, says what it looked for", async () => {
    await setup([]);
    expect(io.stdout()).toMatch(/No supported harness found/);
    expect(listFiles(env.home)).toEqual([]);
  });

  it("with no argument and --yes, sets up every detected harness", async () => {
    mkdirSync(join(env.home, ".codex"));
    await setup(["--yes"]);
    expect(io.stdout()).toContain("Detected: Codex (codex)");
    expect(existsSync(join(env.home, ".codex", "config.toml"))).toBe(true);
  });

  it("with no argument and no terminal, asks for a harness name instead of guessing", async () => {
    mkdirSync(join(env.home, ".codex"));
    await expect(setup([])).rejects.toThrow(/which harness to set up/);
  });

  it("rejects an unknown harness, a bare --remove, and --remove with a positional", async () => {
    await expect(setup(["cursor"])).rejects.toThrow(/Unknown harness "cursor"/);
    await expect(setup(["--remove"])).rejects.toThrow(/--remove requires a value/);
    await expect(setup(["codex", "--remove", "codex"])).rejects.toThrow(/--remove takes the harness itself/);
    await expect(setup(["codex", "--force"])).rejects.toThrow(/Unknown flag: --force/);
  });
});
