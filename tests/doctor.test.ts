import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, NPM_LATEST_URL, npmVersionUrl } from "../src/setup/doctor-command.js";
import { setup } from "../src/setup/setup-command.js";
import { CLI_VERSION } from "../src/version.js";
import { captureConsole } from "./helpers/me-env.js";
import { upsertBlock } from "../src/setup/marked-block.js";
import { CODEX_TOML_MARKERS, codexMcpBlock, codexSkill } from "../src/setup/templates/codex.js";
import { opencodeCommandFiles, opencodeMcpEntry } from "../src/setup/templates/opencode.js";
import { fakeClaude, fakeCodex, fakeOpencode, fakeRunner, setupHomeEnv } from "./helpers/harness-env.js";
import type { RunResult } from "../src/setup/runner.js";
import { setReleaseProbeForTests } from "../src/setup/release-channel.js";

const MCP_URL = "https://www.ahood.dev/api/mcp";

/** `plugin`: the HTTP status npm gives for @ahood/opencode-plugin at this CLI's version (default 200). */
type Net = { mcp?: number | "down"; npm?: string; plugin?: number };
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
      if (url === npmVersionUrl("@ahood/opencode-plugin", CLI_VERSION)) return new Response("{}", { status: net.plugin ?? 200 });
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
    expect(check("codex", "plugin config")).toMatchObject({ status: "ok", detail: expect.stringContaining("(marketplace ref release)") });
    expect(check("codex", "channel")).toMatchObject({ status: "ok", detail: expect.stringContaining("release branch") });
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

  it("a Codex block not on the release branch (ahood#1018 step B) is stale and names both refs", async () => {
    stubNet();
    useCodex();
    await setup(["codex", "--yes"]);
    const path = join(env.home, ".codex", "config.toml");
    const pinned = readFileSync(path, "utf-8");
    for (const [ref, shown] of [
      [null, "unpinned (the repo's default branch)"],
      [`v${CLI_VERSION}`, `v${CLI_VERSION}`],
    ] as const) {
      const line = `ref = "release"\n`;
      writeFileSync(path, pinned.replace(line, ref === null ? "" : `ref = "${ref}"\n`));
      await doctor(["--offline", "--json"]);
      expect(check("codex", "plugin config")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining(`(marketplace ref ${shown}; this CLI tracks the release branch -- re-run \`ahood setup codex\`)`),
      });
      expect(check("codex", "channel")).toMatchObject({ status: "warn", detail: expect.stringContaining("move to the release branch") });
    }
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
    writeFileSync(file, JSON.stringify({ mcp: { servers: { ahood: { type: "remote", url: MCP_URL } } }, plugins: ["@ahood/opencode-plugin"] }));
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

  describe("a codex CLI that gives no answer to `plugin list` (ahood-cli#212)", () => {
    const LIST = "plugin list --json";
    const cacheDir = () => join(env.home, ".codex", "plugins", "cache", "ahood", "ahood", "0.15.0");

    /** Sets Codex up for real, then has `codex plugin list --json` answer `answer` from now on. */
    async function setUpThenList(answer: RunResult | string, { cached = true } = {}) {
      const cx = useCodex();
      await setup(["codex", "--yes"]);
      if (cached) mkdirSync(cacheDir(), { recursive: true });
      runner.restore();
      runner = fakeRunner({ opencode: fakeOpencode(), codex: (args) => (args.join(" ") === LIST ? answer : cx.bin(args)) });
      return cx;
    }

    it.each([
      ["timeout", { status: null, stdout: "", stderr: "" }],
      ["timeout", { status: null, stdout: "", stderr: "", timedOut: true }],
      ["exit", { status: 1, stdout: "", stderr: "Error: something went wrong" }],
      ["parse", "Refreshing the remote catalog...\n{not json"],
    ] as const)("no answer (%s) is a warning read from the plugin cache, never 'not installed'", async (why, answer) => {
      stubNet();
      await setUpThenList(answer as RunResult | string);
      await doctor(["--offline", "--json"]);
      const plugin = check("codex", "plugin");
      expect(plugin).toMatchObject({
        status: "warn",
        detail: `couldn't ask codex (${why}) -- falling back to the plugin cache: ahood@ahood 0.15.0 installed, enabled`,
      });
      expect(plugin.detail).not.toContain("not installed");
      expect(process.exitCode).toBe(0);
    });

    it("an empty plugin cache after a timeout still fails, but says it is the cache that lacks it", async () => {
      stubNet();
      await setUpThenList({ status: null, stdout: "", stderr: "" }, { cached: false });
      await doctor(["--offline", "--json"]);
      const plugin = check("codex", "plugin");
      expect(plugin).toMatchObject({ status: "fail", detail: expect.stringContaining("couldn't ask codex (timeout) -- falling back to the plugin cache: ahood@ahood is not in it") });
      expect(plugin.detail).not.toContain("not installed");
    });

    it("a valid list is still [ok], and `plugin list` gets 45 s, not the runner's default 15 s", async () => {
      stubNet();
      useCodex();
      await setup(["codex", "--yes"]);
      runner.calls.length = 0;
      await doctor(["--offline", "--json"]);
      expect(check("codex", "plugin")).toMatchObject({ status: "ok", detail: "ahood@ahood 0.14.0 installed, enabled" });
      const lists = runner.calls.filter((c) => c.bin === "codex" && c.args.join(" ") === LIST);
      expect(lists.length).toBeGreaterThan(0);
      for (const call of lists) expect(call.timeoutMs).toBe(45_000);
    });

    it("--remove after timeouts uninstalls from the cache's answer and says it could not ask about the marketplace", async () => {
      stubNet();
      const cx = await setUpThenList({ status: null, stdout: "", stderr: "", timedOut: true });
      const realCodex = cx.bin;
      runner.restore();
      runner = fakeRunner({
        opencode: fakeOpencode(),
        codex: (args) => {
          const cmd = args.join(" ");
          if (cmd === LIST || cmd === "plugin marketplace list --json") return { status: null, stdout: "", stderr: "", timedOut: true };
          return realCodex(args);
        },
      });
      await setup(["--remove", "codex", "--yes"]);
      const ran = runner.calls.map((c) => c.args.join(" "));
      expect(ran).toContain("plugin remove ahood@ahood");
      expect(ran).not.toContain("plugin marketplace remove ahood");
      expect(io.stdout()).toContain("couldn't ask codex (timeout) -- falling back to the plugin cache");
      expect(io.stdout()).toContain("couldn't ask codex (timeout) whether the ahood marketplace is cloned");
    });
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

    it("opencode: separate MCP config and plugin checks, both ok once set up (ahood#1009)", async () => {
      stubNet();
      await setup(["opencode", "--yes"]);
      await doctor(["--offline", "--json"]);
      expect(check("opencode", "MCP config")).toMatchObject({ status: "ok" });
      expect(check("opencode", "plugin")).toMatchObject({ status: "ok" });
      expect(check("opencode", "plugin on npm")).toMatchObject({ status: "skip" });
      expect(check("opencode", "old command files")).toBeUndefined();
      expect(harness("opencode").config.state).toBe("ok");
    });

    it("opencode: warns clearly when @ahood/opencode-plugin is not on npm at this version (opencode would skip it silently)", async () => {
      stubNet({ plugin: 404 });
      await setup(["opencode", "--yes"]);
      await doctor(["--json"]);
      const npm = check("opencode", "plugin on npm");
      expect(npm).toMatchObject({ status: "warn" });
      expect(npm.detail).toContain(`@ahood/opencode-plugin@${CLI_VERSION} is NOT on npm`);
      expect(npm.detail).toMatch(/no \/ahood commands/);
    });

    it("opencode: plugin on npm is ok when that version is published", async () => {
      stubNet();
      await setup(["opencode", "--yes"]);
      await doctor(["--json"]);
      expect(check("opencode", "plugin on npm")).toMatchObject({ status: "ok" });
    });

    it("opencode: a setup from before ahood#1009 (MCP entry + command files, no plugin) is partial, with the old files flagged", async () => {
      const dir = join(env.home, ".config", "opencode");
      mkdirSync(join(dir, "commands"), { recursive: true });
      writeFileSync(join(dir, "opencode.json"), JSON.stringify({ mcp: { servers: { ahood: opencodeMcpEntry() } } }));
      for (const { file, content } of opencodeCommandFiles()) writeFileSync(join(dir, "commands", file), content);
      await doctor(["--offline", "--json"]);
      expect(harness("opencode").config.state).toBe("partial");
      expect(check("opencode", "plugin")).toMatchObject({ status: "fail" });
      expect(check("opencode", "old command files")).toMatchObject({ status: "warn" });
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

describe("ahood doctor: a global `ahood` on PATH (ahood#1018)", () => {
  const globalCli = () => report().cli.find((c: { name: string }) => c.name === "global ahood");
  const withGlobal = (ahood: (args: string[]) => RunResult | string) => {
    runner.restore();
    runner = fakeRunner({ opencode: fakeOpencode(), ahood });
  };

  it("warns, exit 0, when the global CLI is older than this CLI and its plugins, and says how to update", async () => {
    withGlobal((args) => (args[0] === "--version" ? "@ahood/cli 0.13.0\n" : { status: 1, stdout: "", stderr: "Unknown command" }));
    await doctor(["--offline", "--json"]);
    expect(globalCli()).toMatchObject({ status: "warn" });
    expect(globalCli().detail).toContain("0.13.0");
    expect(globalCli().detail).toContain(`older than this CLI and its plugins (${CLI_VERSION})`);
    expect(globalCli().detail).toContain(`npm i -g @ahood/cli@${CLI_VERSION}`);
    expect(globalCli().detail).toContain(`npx -y @ahood/cli@${CLI_VERSION}`);
    expect(runner.calls).toContainEqual(expect.objectContaining({ bin: "ahood", args: ["--version"] }));
    expect(process.exitCode).toBe(0);
  });

  it("prints the warning in the human report too", async () => {
    withGlobal(() => "@ahood/cli 0.13.0\n");
    await doctor(["--offline"]);
    expect(io.stdout()).toMatch(/\[warn\] global ahood: .*0\.13\.0.*npm i -g @ahood\/cli@/);
  });

  it("is ok when the global CLI is this version or newer", async () => {
    withGlobal(() => `@ahood/cli ${CLI_VERSION}\n`);
    await doctor(["--offline", "--json"]);
    expect(globalCli()).toMatchObject({ status: "ok", detail: expect.stringContaining(CLI_VERSION) });
    withGlobal(() => "@ahood/cli 999.0.0\n");
    await doctor(["--offline", "--json"]);
    expect(globalCli()).toMatchObject({ status: "ok", detail: expect.stringContaining("999.0.0") });
  });

  it("is ok with no global `ahood` at all (the plugins use npx)", async () => {
    await doctor(["--offline", "--json"]);
    expect(globalCli()).toMatchObject({ status: "ok", detail: expect.stringContaining("none on PATH") });
  });

  it("warns when the global CLI reports no version", async () => {
    withGlobal(() => ({ status: 1, stdout: "", stderr: "boom" }));
    await doctor(["--offline", "--json"]);
    expect(globalCli()).toMatchObject({ status: "warn", detail: expect.stringContaining("did not report a version") });
  });
});

describe("the release channel (ahood#1018 step B)", () => {
  const cliCheck = (name: string) => report().cli.find((c: { name: string }) => c.name === name);

  it("reports whether GitHub has the release branch, and skips asking with --offline", async () => {
    stubNet();
    let answer: boolean | null = true;
    let asked = 0;
    const restore = setReleaseProbeForTests(async () => (asked++, answer));
    try {
      await doctor(["--json"]);
      expect(cliCheck("release channel")).toMatchObject({ status: "ok", detail: expect.stringContaining("AlexKay28/ahood-cli#release exists") });
      answer = false;
      await doctor(["--json"]);
      expect(cliCheck("release channel")).toMatchObject({ status: "warn", detail: expect.stringContaining("the next ahood-cli release creates it") });
      answer = null;
      await doctor(["--json"]);
      expect(cliCheck("release channel")).toMatchObject({ status: "warn", detail: expect.stringContaining("could not ask GitHub") });
      asked = 0;
      await doctor(["--offline", "--json"]);
      expect(cliCheck("release channel")).toMatchObject({ status: "skip" });
      expect(asked).toBe(0);
    } finally {
      restore();
    }
  });

  it("Claude Code: the channel is the declaration's ref -- release is ok, main or a tag is stale", async () => {
    stubNet();
    runner.restore();
    const claude = fakeClaude();
    runner = fakeRunner({ claude: claude.bin });
    await setup(["claude", "--yes"]);
    await doctor(["--offline", "--json"]);
    expect(check("claude", "channel")).toMatchObject({ status: "ok", detail: expect.stringContaining("release branch (AlexKay28/ahood-cli#release)") });
    expect(harness("claude").config.state).toBe("ok");
    const path = join(env.home, ".claude", "settings.json");
    for (const [ref, shown] of [
      [undefined, "unpinned"],
      ["v0.16.0", "v0.16.0"],
    ] as const) {
      const value = JSON.parse(readFileSync(path, "utf-8"));
      value.extraKnownMarketplaces.ahood.source = { source: "github", repo: "AlexKay28/ahood-cli", ...(ref ? { ref } : {}) };
      writeFileSync(path, JSON.stringify(value));
      claude.state.ref = ref;
      await doctor(["--offline", "--json"]);
      expect(check("claude", "channel")).toMatchObject({ status: "warn", detail: expect.stringContaining(shown) });
      expect(check("claude", "channel").detail).toContain("re-run `ahood setup claude`");
      expect(harness("claude").config.state).toBe("stale");
    }
  });
});
