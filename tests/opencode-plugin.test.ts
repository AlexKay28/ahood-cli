// ahood#1009: the opencode plugin in packages/opencode-plugin -- its generated
// files are exactly what src/setup/templates/opencode-plugin.ts renders, it
// says what every other shell says, and against a stand-in for opencode's
// plugin context it registers the /ahood commands, the ahood MCP server and
// the opt-in snap prompt. The last block runs it in the real opencode.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AHOOD_COMMANDS, AHOOD_MCP_URL, AHOOD_SNAP_PROMPT } from "../src/setup/templates/ahood-commands.js";
import { OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_PACKAGE, opencodePluginFiles } from "../src/setup/templates/opencode-plugin.js";
import { CLI_VERSION } from "../src/version.js";
import { COMMANDS, SNAP_PROMPT } from "../packages/opencode-plugin/src/generated.js";
import { createPlugin, renderTemplate } from "../packages/opencode-plugin/src/server.js";
import type { CommandDefinition, OpencodeEvent, PluginContext, RemoteMcpConfig } from "../packages/opencode-plugin/src/opencode-api.js";

const ROOT = join(import.meta.dirname, "..");
const PLUGIN = join(ROOT, OPENCODE_PLUGIN_DIR);
const manifest = JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf-8"));

describe("the committed opencode plugin files", () => {
  it("are exactly what src/setup/templates/opencode-plugin.ts renders (run `npm run sync-plugin`)", () => {
    for (const { file, content } of opencodePluginFiles()) {
      expect(readFileSync(join(ROOT, file), "utf-8"), file).toBe(content);
    }
  });

  it("the package holds only those, its hand-written code, tsconfig and README (dist/ is build output)", () => {
    const handWritten = ["README.md", "tsconfig.json", "src/server.ts", "src/opencode-api.ts"].map((f) => `${OPENCODE_PLUGIN_DIR}/${f}`);
    const owned = [...opencodePluginFiles().map((f) => f.file), ...handWritten];
    const onDisk = readdirSync(PLUGIN, { recursive: true, encoding: "utf-8" })
      .filter((f) => !f.startsWith("dist") && !f.startsWith("node_modules"))
      .map((f) => `${OPENCODE_PLUGIN_DIR}/${f}`)
      .filter((f) => statSync(join(ROOT, f)).isFile());
    expect(onDisk.sort()).toEqual(owned.sort());
  });

  it("package.json is @ahood/opencode-plugin at the CLI's version, with the `server` entry opencode loads", () => {
    expect(manifest.name).toBe(OPENCODE_PLUGIN_PACKAGE);
    // opencode installs a package plugin by version; tying it to package.json
    // means every CLI release ships a matching plugin.
    expect(manifest.version).toBe(CLI_VERSION);
    expect(manifest.type).toBe("module");
    // opencode resolves `<package>/server`, then `<package>` (@opencode/plugin dist/host.js).
    expect(manifest.exports["./server"]).toBe("./dist/server.js");
    expect(manifest.exports["."]).toBe("./dist/server.js");
    expect(manifest.files).toEqual(["dist"]);
    // No runtime dependencies: the host hands the plugin its whole API.
    expect(manifest.dependencies).toBeUndefined();
  });

  it("the build emitted dist/server.js (npm run build builds the plugin too)", () => {
    expect(existsSync(join(PLUGIN, "dist", "server.js"))).toBe(true);
  });
});

describe("one source of text", () => {
  it("each command's prompt carries the shared body verbatim, plus the user's arguments", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(AHOOD_COMMANDS.map((c) => c.name));
    for (const c of AHOOD_COMMANDS) {
      const ours = COMMANDS.find((x) => x.name === c.name)!;
      expect(ours.description).toBe(c.description);
      expect(ours.template).toContain(c.body);
      expect(ours.template).toContain("$ARGUMENTS");
    }
  });

  it("the snap prompt is the shared one (the Claude Code Stop hook's, too)", () => {
    expect(SNAP_PROMPT).toBe(AHOOD_SNAP_PROMPT);
  });
});

// ---- the plugin against a stand-in for opencode's context -------------------

type Fake = {
  context: PluginContext;
  commands: CommandDefinition[];
  mcp: Map<string, unknown>;
  prompts: Array<Record<string, unknown>>;
  synthetic: Array<{ sessionID: string; text: string }>;
  subscribed: () => boolean;
  emit: (event: OpencodeEvent) => Promise<void>;
};

function fakeContext(opts: { mcp?: Record<string, unknown>; children?: string[] } = {}): Fake {
  const commands: CommandDefinition[] = [];
  const mcp = new Map<string, unknown>(Object.entries(opts.mcp ?? {}));
  const prompts: Array<Record<string, unknown>> = [];
  const synthetic: Array<{ sessionID: string; text: string }> = [];
  const queue: OpencodeEvent[] = [];
  let wake: (() => void) | null = null;
  let subscribed = false;
  const registration = { dispose: async () => {} };
  const context: PluginContext = {
    command: { transform: async (cb) => (cb({ add: (d) => commands.push(d) }), registration) },
    mcp: {
      transform: async (cb) => (cb({ get: (n) => mcp.get(n), set: (n, c: RemoteMcpConfig) => void mcp.set(n, c) }), registration),
    },
    event: {
      subscribe: ({ signal } = {}) => {
        subscribed = true;
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              if (queue.length === 0) await new Promise<void>((r) => (wake = r));
              const next = queue.shift();
              if (next) yield next;
            }
          },
        };
      },
    },
    session: {
      prompt: async (input) => void prompts.push(input),
      synthetic: async (input) => void synthetic.push(input),
      get: async ({ sessionID }) => ((opts.children ?? []).includes(sessionID) ? { parentID: "ses_parent" } : {}),
    },
  };
  return {
    context,
    commands,
    mcp,
    prompts,
    synthetic,
    subscribed: () => subscribed,
    emit: async (event) => {
      queue.push(event);
      wake?.();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const ended = (sessionID: string): OpencodeEvent => ({ type: "session.execution.succeeded", data: { sessionID } });

describe("the plugin in opencode's context", () => {
  let markerDir: string;
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), "ahood-oc-plugin-"));
  });
  afterEach(() => rmSync(markerDir, { recursive: true, force: true }));

  it("default export is the `{ id, setup }` object opencode accepts", async () => {
    const mod = (await import("../packages/opencode-plugin/src/server.js")) as { default: { id: unknown; setup: unknown } };
    expect(mod.default.id).toBe("ahood");
    expect(typeof mod.default.setup).toBe("function");
  });

  it("registers the four /ahood commands; each sends its prompt with the user's arguments", async () => {
    const fake = fakeContext();
    await createPlugin({ env: {}, markerDir }).setup(fake.context);
    expect(fake.commands.map((c) => [c.name, c.description])).toEqual(AHOOD_COMMANDS.map((c) => [c.name, c.description]));
    const sync = fake.commands.find((c) => c.name === "ahood-sync")!;
    await sync.execute({ sessionID: "ses_1", prompt: { text: " alice/foo ", files: [] }, delivery: "steer" });
    expect(fake.prompts).toHaveLength(1);
    const sent = fake.prompts[0];
    expect(sent).toMatchObject({ sessionID: "ses_1", delivery: "steer", files: [] });
    expect(sent.text).toBe(renderTemplate(COMMANDS.find((c) => c.name === "ahood-sync")!.template, "alice/foo"));
    expect(sent.text).toContain(AHOOD_COMMANDS.find((c) => c.name === "ahood-sync")!.body);
    expect(sent.text).toMatch(/User arguments, if any: alice\/foo$/);
    expect(sent.text).not.toContain("$ARGUMENTS");
  });

  it("adds the ahood MCP server with the token from $AHOOD_TOKEN, read at runtime and written nowhere", async () => {
    const fake = fakeContext();
    await createPlugin({ env: { AHOOD_TOKEN: "tok_123" }, markerDir }).setup(fake.context);
    expect(fake.mcp.get("ahood")).toEqual({ type: "remote", url: AHOOD_MCP_URL, headers: { Authorization: "Bearer tok_123" } });
  });

  it("leaves a user's own mcp.servers.ahood (e.g. setup's --store-token entry) alone", async () => {
    const mine = { type: "remote", url: AHOOD_MCP_URL, headers: { Authorization: "Bearer stored" } };
    const fake = fakeContext({ mcp: { ahood: mine } });
    await createPlugin({ env: { AHOOD_TOKEN: "tok_123" }, markerDir }).setup(fake.context);
    expect(fake.mcp.get("ahood")).toBe(mine);
  });

  it("snap hook off (no AHOOD_SNAP_HOOK=1): does not even listen", async () => {
    for (const value of [undefined, "0", "true"]) {
      const fake = fakeContext();
      const cleanup = await createPlugin({ env: { AHOOD_SNAP_HOOK: value }, markerDir }).setup(fake.context);
      expect(fake.subscribed()).toBe(false);
      expect(cleanup).toBeUndefined();
    }
  });

  it("snap hook on: prompts once per top-level session when a turn ends, never in a subagent session", async () => {
    const fake = fakeContext({ children: ["ses_child"] });
    const cleanup = await createPlugin({ env: { AHOOD_SNAP_HOOK: "1" }, markerDir }).setup(fake.context);
    expect(fake.subscribed()).toBe(true);
    await fake.emit({ type: "session.execution.started", data: { sessionID: "ses_a" } });
    expect(fake.synthetic).toEqual([]);
    await fake.emit(ended("ses_a"));
    await fake.emit(ended("ses_a")); // the resumed turn ending: no loop
    await fake.emit(ended("ses_child"));
    await fake.emit(ended("ses_b"));
    expect(fake.synthetic.map((s) => s.sessionID)).toEqual(["ses_a", "ses_b"]);
    expect(fake.synthetic[0].text).toBe(AHOOD_SNAP_PROMPT);
    // Once per session survives an opencode restart: the marker is on disk.
    const again = fakeContext();
    const cleanup2 = await createPlugin({ env: { AHOOD_SNAP_HOOK: "1" }, markerDir }).setup(again.context);
    await again.emit(ended("ses_a"));
    expect(again.synthetic).toEqual([]);
    await (cleanup as () => void)();
    await (cleanup2 as () => void)();
  });

  it("snap hook on but no marker can be written: asks nothing", async () => {
    const blocked = join(markerDir, "file");
    writeFileSync(blocked, "");
    const fake = fakeContext();
    const cleanup = await createPlugin({ env: { AHOOD_SNAP_HOOK: "1" }, markerDir: join(blocked, "sub") }).setup(fake.context);
    await fake.emit(ended("ses_a"));
    expect(fake.synthetic).toEqual([]);
    await (cleanup as () => void)();
  });
});

// The authoritative check is opencode itself: a throwaway HOME whose
// opencode.json lists the built plugin (a local plugin is a directory holding
// server.js), a private `opencode serve`, then what the server reports. Runs
// only when an opencode v2 CLI is on PATH (CI has none). Never touches the
// machine's own opencode service or config.
const opencodeVersion = spawnSync("opencode", ["--version"], { encoding: "utf-8" });
const hasOpencodeV2 = opencodeVersion.status === 0 && /v?([2-9]|\d{2,})\./.test(opencodeVersion.stdout);
describe.skipIf(!hasOpencodeV2)("loads in the real opencode", () => {
  it("opencode lists the plugin as active, with the four commands and the ahood MCP server", async () => {
    const home = mkdtempSync(join(tmpdir(), "ahood-oc-real-"));
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      OPENCODE_PASSWORD: "ahood-test",
      AHOOD_TOKEN: "not-a-real-token",
    };
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugins: [join(PLUGIN, "dist")] }));
    const port = String(40_000 + Math.floor(Math.random() * 20_000));
    const server = spawn("opencode", ["serve", "--port", port, "--hostname", "127.0.0.1"], { cwd: home, env, stdio: "ignore" });
    const api = (op: string) => {
      const r = spawnSync("opencode", ["api", "--server", `http://127.0.0.1:${port}`, op], { cwd: home, env, encoding: "utf-8", timeout: 20_000 });
      try {
        return (JSON.parse(r.stdout) as { data: Array<Record<string, unknown>> }).data;
      } catch {
        return [];
      }
    };
    try {
      let commands: string[] = [];
      for (let i = 0; i < 40 && !AHOOD_COMMANDS.every((c) => commands.includes(c.name)); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        commands = api("command.list").map((c) => String(c.name));
      }
      expect(commands).toEqual(expect.arrayContaining(AHOOD_COMMANDS.map((c) => c.name)));
      const plugin = api("plugin.list").find((p) => p.id === "ahood") as { state?: { status?: string } } | undefined;
      expect(plugin?.state?.status).toBe("active");
      expect(api("mcp.list").map((m) => m.name)).toContain("ahood");
    } finally {
      server.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
