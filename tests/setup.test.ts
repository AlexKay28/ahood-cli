import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";

vi.mock("../src/confirm.js", async (orig) => ({
  ...(await orig<typeof import("../src/confirm.js")>()),
  isInteractive: vi.fn(() => false),
  confirmYesNo: vi.fn(async () => true),
  askLine: vi.fn(async () => ""),
}));

import { confirmYesNo, isInteractive } from "../src/confirm.js";
import { setup } from "../src/setup/setup-command.js";
import { UsageError } from "../src/usage-error.js";
import { codexMcpBlock, codexSkill } from "../src/setup/templates/codex.js";
import { opencodeCommandFiles } from "../src/setup/templates/opencode.js";
import { captureConsole } from "./helpers/me-env.js";
import { fakeClaude, fakeOpencode, fakeRunner, listFiles, setupHomeEnv } from "./helpers/harness-env.js";

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

describe("ahood setup codex (ahood#980)", () => {
  const codex = () => join(env.home, ".codex");
  const config = () => join(codex(), "config.toml");
  const USER_TOML = 'model = "o3"\n\n[projects."/x"]\ntrust_level = "trusted"\n';

  it("fresh install: MCP block, skill and snippet; --yes also appends the AGENTS.md snippet", async () => {
    await setup(["codex", "--yes"]);
    const toml = readFileSync(config(), "utf-8");
    expect(parseToml(toml)).toEqual({ mcp_servers: { ahood: { url: MCP_URL, bearer_token_env_var: "AHOOD_API_TOKEN" } } });
    expect(readFileSync(join(codex(), "skills", "ahood", "SKILL.md"), "utf-8")).toBe(codexSkill());
    expect(readFileSync(join(codex(), "ahood-agents-snippet.md"), "utf-8")).toContain("## ahood");
    expect(readFileSync(join(codex(), "AGENTS.md"), "utf-8")).toContain("## ahood");
    expect(backups(listFiles(codex()))).toEqual([]); // nothing existed, so nothing to back up
    expect(process.exitCode).toBe(0);
  });

  it("keeps the user's TOML byte-for-byte and backs the file up before editing", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    await setup(["codex", "--yes"]);
    const toml = readFileSync(config(), "utf-8");
    expect(toml.startsWith(USER_TOML)).toBe(true);
    expect(toml).toContain(codexMcpBlock());
    const [backup] = backups(listFiles(codex()));
    expect(readFileSync(join(codex(), backup), "utf-8")).toBe(USER_TOML);
  });

  it("re-run is idempotent: no duplicate block, no new backup, nothing rewritten", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    await setup(["codex", "--yes"]);
    const first = listFiles(codex());
    const content = readFileSync(config(), "utf-8");
    await setup(["codex", "--yes"]);
    expect(listFiles(codex())).toEqual(first);
    expect(readFileSync(config(), "utf-8")).toBe(content);
    expect(content.match(/\[mcp_servers\.ahood\]/g)).toHaveLength(1);
    expect(io.stdout()).toContain("Already set up; nothing to change.");
  });

  it("--remove takes out only ahood's entries and keeps the backups", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    writeFileSync(join(codex(), "AGENTS.md"), "# mine\n");
    await setup(["codex", "--yes"]);
    await setup(["--remove", "codex", "--yes"]);
    expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    expect(readFileSync(join(codex(), "AGENTS.md"), "utf-8")).toBe("# mine\n");
    expect(existsSync(join(codex(), "skills", "ahood"))).toBe(false);
    expect(existsSync(join(codex(), "ahood-agents-snippet.md"))).toBe(false);
    expect(backups(listFiles(codex())).length).toBeGreaterThanOrEqual(2);
    // and a second remove has nothing left to do
    await setup(["--remove", "codex", "--yes"]);
    expect(io.stdout()).toContain("Nothing of ahood's to remove.");
  });

  it("refuses a malformed config.toml without writing anything", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), "model = \n[[[broken");
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toMatch(/config\.toml is not valid TOML .*nothing was changed/);
    expect(listFiles(codex())).toEqual(["config.toml"]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses when the user already has their own [mcp_servers.ahood]", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), '[mcp_servers.ahood]\nurl = "https://example.test/mcp"\n');
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toMatch(/already defines \[mcp_servers\.ahood\] outside ahood's managed block/);
    expect(readFileSync(config(), "utf-8")).toBe('[mcp_servers.ahood]\nurl = "https://example.test/mcp"\n');
    expect(process.exitCode).toBe(1);
  });

  it("refuses a damaged ahood block (begin marker without end)", async () => {
    mkdirSync(codex(), { recursive: true });
    const damaged = "# >>> ahood (managed by `ahood setup codex`; remove with `ahood setup --remove codex`) >>>\n";
    writeFileSync(config(), damaged);
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toMatch(/damaged ahood block/);
    expect(readFileSync(config(), "utf-8")).toBe(damaged);
  });

  it("refuses to overwrite a SKILL.md that setup did not write", async () => {
    mkdirSync(join(codex(), "skills", "ahood"), { recursive: true });
    writeFileSync(join(codex(), "skills", "ahood", "SKILL.md"), "my own skill\n");
    await setup(["codex", "--yes"]);
    expect(io.stderr()).toMatch(/SKILL\.md already exists and was not written by `ahood setup`/);
    expect(existsSync(config())).toBe(false); // the whole plan is refused, not half-applied
  });

  it("--dry-run prints the plan and writes nothing", async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(config(), USER_TOML);
    await setup(["codex", "--yes", "--dry-run"]);
    expect(listFiles(codex())).toEqual(["config.toml"]);
    expect(readFileSync(config(), "utf-8")).toBe(USER_TOML);
    expect(io.stdout()).toContain("would update");
    expect(io.stdout()).toContain("Nothing was changed (--dry-run).");
  });

  it("with interactive consent but no --yes, does not touch AGENTS.md", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    await setup(["codex"]);
    expect(confirmYesNo).toHaveBeenCalledOnce();
    expect(existsSync(config())).toBe(true);
    expect(existsSync(join(codex(), "AGENTS.md"))).toBe(false);
    expect(io.stdout()).toMatch(/AGENTS\.md is not edited without --yes/);
  });

  it("a declined prompt changes nothing", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(confirmYesNo).mockResolvedValue(false);
    await setup(["codex"]);
    expect(listFiles(env.home)).toEqual([]);
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

describe("ahood setup opencode (ahood#980)", () => {
  const dir = () => join(env.home, ".config", "opencode");
  const commandsDir = () => join(dir(), "commands");
  const entryOf = (text: string) => (parseJsonc(text) as { mcp?: { servers?: Record<string, unknown> } }).mcp?.servers?.ahood;
  const JSONC = '{\n  // my comment\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "dark",\n}\n';

  beforeEach(() => {
    runner.restore();
    runner = fakeRunner({ opencode: fakeOpencode() });
  });

  it("fresh install: opencode.json with mcp.servers.ahood, and the four /ahood commands", async () => {
    await setup(["opencode", "--yes"]);
    const config = readFileSync(join(dir(), "opencode.json"), "utf-8");
    expect(entryOf(config)).toEqual({ type: "remote", url: MCP_URL, headers: { Authorization: "Bearer {env:AHOOD_API_TOKEN}" } });
    expect(listFiles(commandsDir())).toEqual(["ahood-review.md", "ahood-snap.md", "ahood-sync.md", "ahood.md"]);
    for (const { file, content } of opencodeCommandFiles()) expect(readFileSync(join(commandsDir(), file), "utf-8")).toBe(content);
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

  it("runs marketplace add + plugin install with --yes, and writes no files", async () => {
    const claude = fakeClaude();
    runner.restore();
    runner = fakeRunner({ claude: claude.bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual(["plugin marketplace add AlexKay28/ahood-cli", "plugin install ahood@ahood"]);
    expect(claude.state.installed).toBe(true);
    expect(listFiles(env.home)).toEqual([]);
  });

  it("is idempotent: an installed plugin runs nothing", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true }).bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual([]);
    expect(io.stdout()).toContain("already installed");
  });

  it("skips marketplace add when it is already there", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true }).bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual(["plugin install ahood@ahood"]);
  });

  it("without `plugin` subcommands, prints the in-session /plugin commands and runs nothing", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ supportsPlugins: false }).bin });
    await setup(["claude", "--yes"]);
    expect(mutating()).toEqual([]);
    expect(io.stdout()).toContain("/plugin marketplace add AlexKay28/ahood-cli");
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
    expect(io.stdout()).toContain("would run    claude plugin install ahood@ahood");
  });

  it("--remove uninstalls the plugin and removes the marketplace", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true }).bin });
    await setup(["--remove", "claude", "--yes"]);
    expect(mutating()).toEqual(["plugin uninstall ahood@ahood", "plugin marketplace remove ahood"]);
  });

  it("a failing install exits 1", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ failInstall: true }).bin });
    await setup(["claude", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(io.stderr()).toMatch(/could not install the ahood plugin/);
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
