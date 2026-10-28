import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, NPM_LATEST_URL } from "../src/setup/doctor-command.js";
import { setup } from "../src/setup/setup-command.js";
import { CLI_VERSION } from "../src/version.js";
import { captureConsole } from "./helpers/me-env.js";
import { fakeClaude, fakeOpencode, fakeRunner, setupHomeEnv } from "./helpers/harness-env.js";

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

  it("reports a healthy Codex setup as ok", async () => {
    stubNet();
    await setup(["codex", "--yes"]);
    process.env.AHOOD_API_TOKEN = "t";
    await doctor(["--json"]);
    expect(harness("codex").config.state).toBe("ok");
    expect(check("codex", "MCP server reachable")).toMatchObject({ status: "ok" });
    expect(check("codex", "MCP token")).toMatchObject({ status: "ok" });
    expect(report().ok).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("a partial Codex setup (skill deleted) is broken: exit 1", async () => {
    stubNet();
    await setup(["codex", "--yes"]);
    unlinkSync(join(env.home, ".codex", "skills", "ahood", "SKILL.md"));
    await doctor(["--offline", "--json"]);
    expect(harness("codex").config.state).toBe("partial");
    expect(process.exitCode).toBe(1);
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
    const [login, version] = report().cli;
    expect(login).toMatchObject({ name: "logged in", status: "warn" });
    expect(version).toMatchObject({ status: "warn" });
    expect(version.detail).toContain("999.0.0");
    expect(process.exitCode).toBe(0);
  });

  it("offline with a stored token: token present, not verified", async () => {
    process.env.AHOOD_TOKEN = "t";
    await doctor(["--offline", "--json"]);
    expect(report().cli[0]).toMatchObject({ status: "ok", detail: expect.stringContaining("not verified") });
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
});
