import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, NPM_LATEST_URL } from "../src/setup/doctor-command.js";
import { setup } from "../src/setup/setup-command.js";
import { CLI_VERSION } from "../src/version.js";
import { captureConsole } from "./helpers/me-env.js";
import { upsertBlock } from "../src/setup/marked-block.js";
import { CODEX_TOML_MARKERS, codexMcpBlock, codexSkill } from "../src/setup/templates/codex.js";
import { fakeClaude, fakeCodex, fakeOpencode, fakeRunner, setupHomeEnv } from "./helpers/harness-env.js";

const MCP_URL = "https://www.ahood.dev/api/mcp";

type Net = { mcp?: number | "down"; npm?: string };
function stubNet(net: Net = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === MCP_URL) {
        if (net.mcp === "down") throw new TypeError("fetch failed");
        return new Response("", { status: net.mcp ?? 405 });
      }
      if (url === NPM_LATEST_URL) return new Response(JSON.stringify({ version: net.npm ?? CLI_VERSION }), { status: 200 });
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    }),
  );
  return urls;
}

let env: ReturnType<typeof setupHomeEnv>;
let io: ReturnType<typeof captureConsole>;
let runner: ReturnType<typeof fakeRunner>;

beforeEach(() => {
  env = setupHomeEnv();
  io = captureConsole();
  runner = fakeRunner({ opencode: fakeOpencode() });
});
afterEach(() => {
  runner.restore();
  env.restore();
});

/** Puts a fake codex CLI with `plugin` subcommands on PATH (beside opencode). */
function useCodex() {
  const cx = fakeCodex();
  runner.restore();
  runner = fakeRunner({ opencode: fakeOpencode(), codex: cx.bin });
  return cx;
}

const report = () => JSON.parse(io.out[io.out.length - 1]);
const harness = (id: string) => report().harnesses.find((h: { id: string }) => h.id === id);
const check = (id: string, name: string) => harness(id).checks.find((c: { name: string }) => c.name === name);

describe("ahood doctor (ahood#980)", () => {
  it("--offline makes no network call and, with nothing set up, exits 0", async () => {
    const urls = stubNet();
    await doctor(["--offline"]);
    expect(urls).toEqual([]);
    expect(io.stdout()).toContain("No harness is set up yet");
    expect(process.exitCode).toBe(0);
  });

  it("reports a healthy Codex setup as ok, naming the installed plugin's version", async () => {
    stubNet();
    useCodex();
    await setup(["codex", "--yes"]);
    process.env.AHOOD_TOKEN = "t";
    await doctor(["--json"]);
    expect(harness("codex").config.state).toBe("ok");
    expect(check("codex", "plugin")).toMatchObject({ status: "ok", detail: "ahood@ahood 0.14.0 installed, enabled" });
    expect(check("codex", "MCP server reachable")).toMatchObject({ status: "ok" });
    expect(check("codex", "MCP token")).toMatchObject({ status: "ok" });
    expect(report().ok).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("a partial Codex setup (block written, plugin never installed) is broken: exit 1", async () => {
    stubNet();
    await setup(["codex", "--yes"]); // no codex CLI on PATH, so nothing installed it
    await doctor(["--offline", "--json"]);
    expect(harness("codex").config.state).toBe("partial");
    expect(check("codex", "plugin")).toMatchObject({ status: "fail", detail: expect.stringContaining("not installed") });
    expect(process.exitCode).toBe(1);
  });

  it("a Codex plugin the user disabled is a warning, not a failure", async () => {
    stubNet();
    const cx = useCodex();
    await setup(["codex", "--yes"]);
    cx.state.enabled = false;
    await doctor(["--offline", "--json"]);
    expect(harness("codex").config.state).toBe("stale");
    expect(check("codex", "plugin")).toMatchObject({ status: "warn", detail: expect.stringContaining("installed but disabled") });
    expect(process.exitCode).toBe(0);
  });

  it("without a codex CLI, reads the plugin cache and config.toml's enabled flag instead", async () => {
    stubNet();
    await setup(["codex", "--yes"]);
    mkdirSync(join(env.home, ".codex", "plugins", "cache", "ahood", "ahood", "0.14.0"), { recursive: true });
    await doctor(["--offline", "--json"]);
    expect(harness("codex").config.state).toBe("ok");
    expect(check("codex", "plugin")).toMatchObject({ status: "ok", detail: "ahood@ahood 0.14.0 installed, enabled" });
  });

  it("a pre-plugin Codex setup (ahood#1009) is flagged so a re-run migrates it", async () => {
    mkdirSync(join(env.home, ".codex", "skills", "ahood"), { recursive: true });
    writeFileSync(join(env.home, ".codex", "config.toml"), upsertBlock("", codexMcpBlock(), CODEX_TOML_MARKERS, "config.toml"));
    writeFileSync(join(env.home, ".codex", "skills", "ahood", "SKILL.md"), codexSkill());
    await doctor(["--offline", "--json"]);
    expect(check("codex", "plugin config")).toMatchObject({ status: "warn" });
    expect(check("codex", "old setup files")).toMatchObject({ status: "warn", detail: expect.stringContaining("re-run `ahood setup codex`") });
    expect(process.exitCode).toBe(1); // the plugin itself is not installed yet
  });

  it("an unreadable config.toml is broken", async () => {
    mkdirSync(join(env.home, ".codex"));
    writeFileSync(join(env.home, ".codex", "config.toml"), "[[[");
    await doctor(["--offline"]);
    expect(io.stdout()).toMatch(/\[FAIL\] ahood config: broken/);
    expect(process.exitCode).toBe(1);
  });

  it("an unreachable MCP server fails a configured harness", async () => {
    stubNet({ mcp: "down" });
    await setup(["opencode", "--yes"]);
    await doctor(["--json"]);
    expect(check("opencode", "MCP server reachable")).toMatchObject({ status: "fail" });
    expect(report().ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("a 5xx from the MCP server is a failure too; an unconfigured harness is not judged on it", async () => {
    stubNet({ mcp: 503 });
    await doctor(["--json"]);
    expect(check("codex", "MCP server reachable")).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("warns (exit 0) on a stale config, a missing token and an older CLI", async () => {
    stubNet({ npm: "999.0.0" });
    await setup(["opencode", "--yes"]);
    const file = join(env.home, ".config", "opencode", "opencode.json");
    writeFileSync(file, JSON.stringify({ mcp: { servers: { ahood: { type: "remote", url: MCP_URL } } } }));
    await doctor(["--json"]);
    expect(harness("opencode").config.state).toBe("stale");
    expect(check("opencode", "MCP token")).toMatchObject({ status: "warn" });
    const [, login, version] = report().cli;
    expect(login).toMatchObject({ name: "logged in", status: "warn" });
    expect(version).toMatchObject({ status: "warn" });
    expect(version.detail).toContain("999.0.0");
    expect(process.exitCode).toBe(0);
  });

  it("offline with a stored token: token present, not verified", async () => {
    process.env.AHOOD_TOKEN = "t";
    await doctor(["--offline", "--json"]);
    expect(report().cli.find((c: { name: string }) => c.name === "logged in")).toMatchObject({ status: "ok", detail: expect.stringContaining("not verified") });
  });

  it("Claude Code: installed plugin is ok; disabled is a warning", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true }).bin });
    await doctor(["--offline", "--json"]);
    expect(harness("claude")).toMatchObject({ detected: true, config: { state: "ok" } });

    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true, enabled: false }).bin });
    await doctor(["--offline", "--json"]);
    expect(harness("claude").config.state).toBe("stale");
    expect(process.exitCode).toBe(0);
  });

  it("Claude Code: marketplace added but plugin missing is partial", async () => {
    runner.restore();
    runner = fakeRunner({ claude: fakeClaude({ marketplace: true }).bin });
    await doctor(["--offline", "--json"]);
    expect(harness("claude").config.state).toBe("partial");
    expect(process.exitCode).toBe(1);
  });

  it("rejects unknown arguments", async () => {
    await expect(doctor(["--fix"])).rejects.toThrow(/Unknown argument: --fix/);
  });

  describe("per-harness feature breakdown (ahood#982)", () => {
    it("codex: separate plugin config and plugin checks, both ok once set up", async () => {
      stubNet();
      useCodex();
      await setup(["codex", "--yes"]);
      await doctor(["--offline", "--json"]);
      expect(check("codex", "plugin config")).toMatchObject({ status: "ok" });
      expect(check("codex", "plugin")).toMatchObject({ status: "ok" });
    });

    it("codex: a plugin uninstalled behind setup's back is its own failing check", async () => {
      stubNet();
      const cx = useCodex();
      await setup(["codex", "--yes"]);
      cx.state.installed = false;
      await doctor(["--offline", "--json"]);
      expect(check("codex", "plugin config")).toMatchObject({ status: "ok" });
      expect(check("codex", "plugin")).toMatchObject({ status: "fail" });
    });

    it("opencode: separate MCP config and commands checks, both ok once set up", async () => {
      stubNet();
      await setup(["opencode", "--yes"]);
      await doctor(["--offline", "--json"]);
      expect(check("opencode", "MCP config")).toMatchObject({ status: "ok" });
      expect(check("opencode", "commands")).toMatchObject({ status: "ok" });
    });

    it("a harness that was never set up reports no per-feature checks (nothing to break down)", async () => {
      await doctor(["--offline", "--json"]);
      expect(check("codex", "plugin config")).toBeUndefined();
      expect(check("codex", "plugin")).toBeUndefined();
    });

    it("Claude Code: a `plugin` check plus a `snap hook` check that defaults to skipped, not failed", async () => {
      runner.restore();
      runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true }).bin });
      await doctor(["--offline", "--json"]);
      expect(check("claude", "plugin")).toMatchObject({ status: "ok" });
      expect(check("claude", "snap hook")).toMatchObject({ status: "skip" });
      expect(process.exitCode).toBe(0);
    });

    it("Claude Code: AHOOD_SNAP_HOOK=1 reports the snap hook as enabled, never as a failure", async () => {
      runner.restore();
      runner = fakeRunner({ claude: fakeClaude({ marketplace: true, installed: true }).bin });
      process.env.AHOOD_SNAP_HOOK = "1";
      await doctor(["--offline", "--json"]);
      expect(check("claude", "snap hook")).toMatchObject({ status: "ok", detail: expect.stringContaining("enabled") });
      expect(process.exitCode).toBe(0);
    });

    it("Claude Code: the snap hook check never appears before the plugin itself is installed", async () => {
      process.env.AHOOD_SNAP_HOOK = "1";
      await doctor(["--offline", "--json"]);
      expect(check("claude", "snap hook")).toBeUndefined();
    });
  });
});
