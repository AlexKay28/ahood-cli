// ahood#990: one token name (AHOOD_TOKEN, AHOOD_API_TOKEN as a deprecated
// fallback) and `ahood setup` storing the token in each harness's own config,
// only with consent, user-only where setup creates the file, removed by
// --remove -- and the token itself never in stdout or stderr.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";

vi.mock("../src/confirm.js", async (orig) => ({
  ...(await orig<typeof import("../src/confirm.js")>()),
  isInteractive: vi.fn(() => false),
  confirmYesNo: vi.fn(async () => true),
  askLine: vi.fn(async () => ""),
}));
vi.mock("../src/commands/login.js", () => ({ login: vi.fn(async () => {}) }));

import { askLine, confirmYesNo, isInteractive } from "../src/confirm.js";
import { login } from "../src/commands/login.js";
import {
  LEGACY_TOKEN_NOTE,
  resetLegacyTokenNoteForTests,
  resolveToken,
  resolveTokenWithSource,
  writeCredentials,
} from "../src/credentials.js";
import { setup } from "../src/setup/setup-command.js";
import { doctor } from "../src/setup/doctor-command.js";
import { REDACTED_TOKEN } from "../src/setup/file-changes.js";
import { captureConsole } from "./helpers/me-env.js";
import { upsertBlock } from "../src/setup/marked-block.js";
import { CODEX_TOML_MARKERS, codexMcpBlock, codexPluginBlock } from "../src/setup/templates/codex.js";
import { fakeClaude, fakeCodex, fakeOpencode, fakeRunner, listFiles, setupHomeEnv } from "./helpers/harness-env.js";

const TOKEN = "ahd_s3cr3t_TOKEN_990";
const OTHER = "ahd_other_TOKEN_990";

let env: ReturnType<typeof setupHomeEnv>;
let io: ReturnType<typeof captureConsole>;
let runner: ReturnType<typeof fakeRunner>;

const mode = (path: string) => statSync(path).mode & 0o777;
const codexConfig = () => join(env.home, ".codex", "config.toml");
const opencodeConfig = () => join(env.home, ".config", "opencode", "opencode.json");
const claudeSettings = () => join(env.home, ".claude", "settings.json");
/** The `[mcp_servers.ahood]` entry in config.toml: since ahood#1009 there is one only to hold a stored token. */
const tomlEntry = () => (parseToml(readFileSync(codexConfig(), "utf-8")) as { mcp_servers?: Record<string, Record<string, unknown>> }).mcp_servers?.ahood;
/** Every file under `dir` whose bytes contain `needle`. */
const filesHolding = (dir: string, needle: string) => listFiles(dir).filter((f) => readFileSync(join(dir, f), "utf-8").includes(needle));

beforeEach(() => {
  env = setupHomeEnv();
  io = captureConsole();
  runner = fakeRunner({ opencode: fakeOpencode() });
  resetLegacyTokenNoteForTests();
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.mocked(confirmYesNo).mockResolvedValue(true);
  vi.mocked(askLine).mockResolvedValue("");
  vi.mocked(login).mockReset();
});
afterEach(() => {
  // The one rule every case here shares: the token never reaches the terminal.
  for (const secret of [TOKEN, OTHER]) {
    expect(io.stdout()).not.toContain(secret);
    expect(io.stderr()).not.toContain(secret);
  }
  runner.restore();
  env.restore();
});

describe("token resolution order (ahood#990, decision A)", () => {
  it("AHOOD_TOKEN, then AHOOD_API_TOKEN, then the stored login", () => {
    writeCredentials({ token: "stored" });
    expect(resolveTokenWithSource()).toEqual({ token: "stored", source: "credentials" });
    process.env.AHOOD_API_TOKEN = "legacy";
    expect(resolveTokenWithSource()).toEqual({ token: "legacy", source: "AHOOD_API_TOKEN" });
    process.env.AHOOD_TOKEN = "current";
    expect(resolveTokenWithSource()).toEqual({ token: "current", source: "AHOOD_TOKEN" });
  });

  it("an empty variable falls through to the next source", () => {
    process.env.AHOOD_TOKEN = "";
    process.env.AHOOD_API_TOKEN = "legacy";
    expect(resolveTokenWithSource()?.source).toBe("AHOOD_API_TOKEN");
  });

  it("only AHOOD_API_TOKEN set: works, with a one-time deprecation note on stderr (never stdout, never the value)", () => {
    process.env.AHOOD_API_TOKEN = TOKEN;
    expect(resolveToken()).toBe(TOKEN);
    expect(resolveToken()).toBe(TOKEN);
    expect(io.err).toEqual([LEGACY_TOKEN_NOTE]);
    expect(LEGACY_TOKEN_NOTE).toContain("AHOOD_TOKEN");
    expect(io.out).toEqual([]);
  });

  it("no note when AHOOD_TOKEN is set, even with the old name also set", () => {
    process.env.AHOOD_TOKEN = TOKEN;
    process.env.AHOOD_API_TOKEN = OTHER;
    expect(resolveToken()).toBe(TOKEN);
    expect(io.err).toEqual([]);
  });
});

describe("ahood setup offers login first", () => {
  it("interactive with no token: asks, and runs the login flow on yes", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("n"); // the login question, then the token questions
    vi.mocked(askLine).mockResolvedValueOnce("y");
    await setup(["codex"]);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("interactive, declined: no login, setup still runs", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("n");
    await setup(["codex"]);
    expect(login).not.toHaveBeenCalled();
    expect(io.stdout()).toContain("Continuing without a token");
    expect(existsSync(codexConfig())).toBe(true);
  });

  it("non-interactive: never starts the device flow, says how to log in", async () => {
    await setup(["codex", "--yes"]);
    expect(login).not.toHaveBeenCalled();
    expect(io.stdout()).toContain("Not logged in to ahood");
  });

  it("already logged in: no question, no login", async () => {
    writeCredentials({ token: TOKEN });
    await setup(["codex", "--yes"]);
    expect(login).not.toHaveBeenCalled();
  });

  it("--remove and --dry-run never log in", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    await setup(["codex", "--dry-run"]);
    await setup(["--remove", "codex", "--yes"]);
    expect(login).not.toHaveBeenCalled();
  });
});

describe("Codex: the token in config.toml (ahood#990, decision B)", () => {
  beforeEach(() => writeCredentials({ token: TOKEN }));

  it("--yes alone never stores the token: no MCP entry (the plugin's names $AHOOD_TOKEN) and the note says how", async () => {
    await setup(["codex", "--yes"]);
    expect(tomlEntry()).toBeUndefined();
    expect(filesHolding(join(env.home, ".codex"), TOKEN)).toEqual([]);
    expect(io.stdout()).toContain("export AHOOD_TOKEN=<your token>");
    expect(io.stdout()).toContain("--store-token");
  });

  it("--store-token: the token in a full [mcp_servers.ahood] in the managed block, beside the plugin; the file it creates is 0600", async () => {
    await setup(["codex", "--yes", "--store-token"]);
    // A full entry (url included): it takes the place of the plugin's server, and a partial one would not load.
    expect(tomlEntry()).toEqual({ url: "https://www.ahood.dev/api/mcp", http_headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(readFileSync(codexConfig(), "utf-8")).toContain(codexPluginBlock(TOKEN));
    expect(mode(codexConfig())).toBe(0o600);
    expect(io.stdout()).toContain("with your ahood token");
  });

  it("interactive consent stores it; an existing 0600 file keeps its mode", async () => {
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), 'model = "o3"\n', { mode: 0o600 });
    chmodSync(codexConfig(), 0o600);
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("y");
    await setup(["codex"]);
    expect(tomlEntry()?.http_headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(mode(codexConfig())).toBe(0o600);
    expect(vi.mocked(askLine).mock.calls.some(([q]) => q.includes("store your ahood token in ~/.codex/config.toml"))).toBe(true);
  });

  it("interactive, declined (the default): not stored", async () => {
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("");
    await setup(["codex"]);
    expect(tomlEntry()).toBeUndefined();
    expect(filesHolding(join(env.home, ".codex"), TOKEN)).toEqual([]);
  });

  it("an existing world-readable config: non-interactive never chmods it and does not store the token there", async () => {
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), 'model = "o3"\n');
    chmodSync(codexConfig(), 0o644);
    await setup(["codex", "--yes", "--store-token"]);
    expect(mode(codexConfig())).toBe(0o644);
    expect(filesHolding(join(env.home, ".codex"), TOKEN)).toEqual([]);
    expect(io.stderr()).toContain("readable by other users (mode 0644)");
  });

  it("an existing world-readable config: interactive, tightened to 0600 only on a separate yes", async () => {
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), 'model = "o3"\n');
    chmodSync(codexConfig(), 0o644);
    vi.mocked(isInteractive).mockReturnValue(true);
    vi.mocked(askLine).mockResolvedValue("y");
    vi.mocked(confirmYesNo).mockResolvedValueOnce(false); // chmod? no
    await setup(["codex"]);
    expect(mode(codexConfig())).toBe(0o644);
    expect(filesHolding(join(env.home, ".codex"), TOKEN)).toEqual([]);

    vi.mocked(confirmYesNo).mockResolvedValue(true); // chmod? yes; apply? yes
    await setup(["codex"]);
    expect(mode(codexConfig())).toBe(0o600);
    expect(tomlEntry()?.http_headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("an edit without a token keeps the file's own mode (the atomic rename used to reset it)", async () => {
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), 'model = "o3"\n');
    chmodSync(codexConfig(), 0o640);
    await setup(["codex", "--yes"]);
    expect(mode(codexConfig())).toBe(0o640);
  });

  it("a re-run without the flag keeps (and refreshes) a stored token; --no-store-token takes it out", async () => {
    await setup(["codex", "--yes", "--store-token"]);
    writeCredentials({ token: OTHER });
    await setup(["codex", "--yes"]);
    expect(tomlEntry()?.http_headers).toEqual({ Authorization: `Bearer ${OTHER}` });
    await setup(["codex", "--yes", "--no-store-token"]);
    expect(tomlEntry()).toBeUndefined();
    expect(filesHolding(join(env.home, ".codex"), OTHER)).toEqual([]); // the backup of the edit is redacted too
  });

  it("a stored token from the pre-plugin setup survives the migration (same consent), then --remove takes it out", async () => {
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), upsertBlock('model = "o3"\n', codexMcpBlock(TOKEN), CODEX_TOML_MARKERS, codexConfig()), { mode: 0o600 });
    await setup(["codex", "--yes"]);
    expect(tomlEntry()?.http_headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(readFileSync(codexConfig(), "utf-8")).toContain(codexPluginBlock(TOKEN));
    expect(filesHolding(join(env.home, ".codex"), TOKEN)).toEqual(["config.toml"]); // the backup is redacted
    await setup(["--remove", "codex", "--yes"]);
    expect(readFileSync(codexConfig(), "utf-8")).toBe('model = "o3"\n');
  });

  it("--remove deletes the stored token; the backup of the user's file has it redacted and is 0600", async () => {
    mkdirSync(join(env.home, ".codex"), { recursive: true });
    writeFileSync(codexConfig(), 'model = "o3"\n', { mode: 0o600 });
    await setup(["codex", "--yes", "--store-token"]);
    await setup(["--remove", "codex", "--yes"]);
    expect(readFileSync(codexConfig(), "utf-8")).toBe('model = "o3"\n');
    expect(filesHolding(join(env.home, ".codex"), TOKEN)).toEqual([]);
    const backups = listFiles(join(env.home, ".codex")).filter((f) => f.startsWith("config.toml.ahood-backup-"));
    const redacted = backups.filter((f) => readFileSync(join(env.home, ".codex", f), "utf-8").includes(REDACTED_TOKEN));
    expect(redacted.length).toBeGreaterThan(0);
    for (const f of redacted) expect(mode(join(env.home, ".codex", f))).toBe(0o600);
    expect(io.stdout()).toContain("stored token removed");
  });

  it("doctor: a stored token counts as the MCP token, and the config is ok (not stale)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    runner.restore();
    runner = fakeRunner({ opencode: fakeOpencode(), codex: fakeCodex().bin });
    await setup(["codex", "--yes", "--store-token"]);
    await doctor(["--offline", "--json"]);
    const report = JSON.parse(io.out[io.out.length - 1]);
    const codex = report.harnesses.find((h: { id: string }) => h.id === "codex");
    expect(codex.config.state).toBe("ok");
    expect(codex.checks.find((c: { name: string }) => c.name === "MCP token")).toMatchObject({ status: "ok", detail: expect.stringContaining("stored by ahood setup") });
  });
});

describe("opencode: the token in opencode.json", () => {
  beforeEach(() => writeCredentials({ token: TOKEN }));
  const entry = () => (parseJsonc(readFileSync(opencodeConfig(), "utf-8")) as { mcp: { servers: Record<string, unknown> } }).mcp.servers.ahood;

  it("--store-token: a literal Authorization header in a 0600 file; --remove takes it out", async () => {
    await setup(["opencode", "--yes", "--store-token"]);
    expect(entry()).toEqual({ type: "remote", url: "https://www.ahood.dev/api/mcp", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(mode(opencodeConfig())).toBe(0o600);
    await setup(["--remove", "opencode", "--yes"]);
    expect(filesHolding(join(env.home, ".config", "opencode"), TOKEN)).toEqual([]);
  });

  it("without consent the header names {env:AHOOD_TOKEN}", async () => {
    await setup(["opencode", "--yes"]);
    expect(entry()).toEqual({ type: "remote", url: "https://www.ahood.dev/api/mcp", headers: { Authorization: "Bearer {env:AHOOD_TOKEN}" } });
  });
});

describe("Claude Code: env.AHOOD_TOKEN in ~/.claude/settings.json", () => {
  beforeEach(() => writeCredentials({ token: TOKEN }));
  const settings = () => JSON.parse(readFileSync(claudeSettings(), "utf-8")) as { env?: Record<string, string>; model?: string };

  it("--store-token writes env.AHOOD_TOKEN with setup's marker; --remove deletes only those keys", async () => {
    const claude = fakeClaude({ marketplace: true, installed: true });
    runner.restore();
    runner = fakeRunner({ claude: claude.bin });
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    writeFileSync(claudeSettings(), JSON.stringify({ model: "opus", env: { OTHER_VAR: "1" } }, null, 2), { mode: 0o600 });
    chmodSync(claudeSettings(), 0o600);
    await setup(["claude", "--yes", "--store-token"]);
    expect(settings().env?.AHOOD_TOKEN).toBe(TOKEN);
    expect(settings().env?.AHOOD_TOKEN_SET_BY).toContain("ahood setup");
    expect(settings().model).toBe("opus");
    expect(mode(claudeSettings())).toBe(0o600);
    await setup(["--remove", "claude", "--yes"]);
    expect(settings()).toEqual({ model: "opus", env: { OTHER_VAR: "1" } });
    expect(filesHolding(join(env.home, ".claude"), TOKEN)).toEqual([]);
  });

  it("a settings.json setup creates is 0600, and an emptied env map goes with the token", async () => {
    await setup(["claude", "--yes", "--store-token"]);
    expect(mode(claudeSettings())).toBe(0o600);
    await setup(["--remove", "claude", "--yes"]);
    expect(settings()).toEqual({});
  });

  it("an AHOOD_TOKEN the user set there is never changed or removed", async () => {
    mkdirSync(join(env.home, ".claude"), { recursive: true });
    writeFileSync(claudeSettings(), JSON.stringify({ env: { AHOOD_TOKEN: OTHER } }), { mode: 0o600 });
    await setup(["claude", "--yes", "--store-token"]);
    await setup(["--remove", "claude", "--yes"]);
    expect(settings().env?.AHOOD_TOKEN).toBe(OTHER);
  });

  it("without consent: nothing written, and the note says to export AHOOD_TOKEN (and rename the old name)", async () => {
    process.env.AHOOD_API_TOKEN = TOKEN;
    await setup(["claude", "--yes"]);
    expect(existsSync(claudeSettings())).toBe(false);
    expect(io.stdout()).toContain("export AHOOD_TOKEN=<your token>");
    expect(io.stdout()).toContain("reads AHOOD_TOKEN, not AHOOD_API_TOKEN");
  });
});

describe("ahood doctor names the token source, never the token", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 }))));
  const source = () => JSON.parse(io.out[io.out.length - 1]).cli.find((c: { name: string }) => c.name === "token source");

  it.each([
    ["AHOOD_TOKEN", "ok", "$AHOOD_TOKEN"],
    ["AHOOD_API_TOKEN", "warn", "only $AHOOD_API_TOKEN is set"],
  ])("%s set", async (name, status, detail) => {
    process.env[name] = TOKEN;
    await doctor(["--offline", "--json"]);
    expect(source()).toMatchObject({ status, detail: expect.stringContaining(detail) });
  });

  it("stored login", async () => {
    writeCredentials({ token: TOKEN });
    await doctor(["--offline", "--json"]);
    expect(source()).toMatchObject({ status: "ok", detail: expect.stringContaining("stored login") });
  });

  it("an AHOOD_API_TOKEN-only shell is flagged on a set-up harness too", async () => {
    await setup(["codex", "--yes"]);
    process.env.AHOOD_API_TOKEN = TOKEN;
    await doctor(["--offline"]);
    expect(io.stdout()).toMatch(/\[warn\] token source: only \$AHOOD_API_TOKEN is set/);
    expect(io.stdout()).toMatch(/\[warn\] MCP token: only AHOOD_API_TOKEN is set/);
  });
});
