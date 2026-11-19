// ahood#981: the opt-in snap Stop hook (plugins/ahood/hooks) and the plugin skill.
// ahood#1554 step 5: the SessionStart hook (session-start.mjs) joins it below.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PLUGIN_DIR, claudePluginSessionStartHook } from "../src/setup/templates/claude-plugin.js";
import { CLI_VERSION } from "../src/version.js";

const PLUGIN = join(import.meta.dirname, "..", CLAUDE_PLUGIN_DIR);
const SCRIPT = join(PLUGIN, "hooks", "snap-prompt.mjs");
const SESSION_START_SCRIPT = join(PLUGIN, "hooks", "session-start.mjs");

function runHook(env: Record<string, string>, input: unknown) {
  const dataDir = mkdtempSync(join(tmpdir(), "ahood-hook-"));
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", CLAUDE_PLUGIN_DATA: dataDir, ...env };
  const run = () =>
    spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), env: childEnv, encoding: "utf-8" });
  return { run, dataDir };
}

const stop = (extra: Record<string, unknown> = {}) => ({
  session_id: "sess-1",
  hook_event_name: "Stop",
  stop_hook_active: false,
  ...extra,
});

describe("hooks/hooks.json", () => {
  it("registers exactly SessionStart and Stop, each one command hook running its own bundled script", () => {
    const config = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf-8"));
    expect(Object.keys(config)).toEqual(["hooks"]);
    expect(Object.keys(config.hooks).sort()).toEqual(["SessionStart", "Stop"]);
    expect(config.hooks.Stop).toHaveLength(1);
    const [stopGroup] = config.hooks.Stop;
    expect(stopGroup.matcher).toBeUndefined(); // Stop takes no matcher
    expect(stopGroup.hooks).toEqual([
      { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/snap-prompt.mjs"', timeout: 10 },
    ]);
    expect(config.hooks.SessionStart).toHaveLength(1);
    const [startGroup] = config.hooks.SessionStart;
    expect(startGroup.matcher).toBeUndefined();
    expect(startGroup.hooks).toEqual([
      { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"', timeout: 5 },
    ]);
  });

  it("is exactly what claude-plugin.ts renders (run `npm run sync-plugin`)", () => {
    expect(readFileSync(join(PLUGIN, "hooks", "session-start.mjs"), "utf-8")).toBe(claudePluginSessionStartHook());
  });
});

describe("hooks/session-start.mjs", () => {
  function runHook(env: Record<string, string>, input: unknown, statusStub?: { exit: number; stdout: string }) {
    const dataDir = mkdtempSync(join(tmpdir(), "ahood-session-start-"));
    // AHOOD_CLI_STUB, read by a tiny fake `npx` this test puts first on PATH,
    // stands in for the real network call runStatus() makes -- so these
    // tests exercise the hook's actual parsing/caching/budget logic against
    // a controlled `status --json` answer, never the real registry.
    const binDir = mkdtempSync(join(tmpdir(), "ahood-session-start-bin-"));
    const npxStub = join(binDir, "npx");
    writeFileSync(
      npxStub,
      statusStub
        ? `#!/bin/sh\necho '${statusStub.stdout.replace(/'/g, "'\\''")}'\nexit ${statusStub.exit}\n`
        : `#!/bin/sh\nexit 1\n`,
    );
    chmodSync(npxStub, 0o755);
    const childEnv: Record<string, string> = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CLAUDE_PLUGIN_DATA: dataDir,
      ...env,
    };
    const run = () =>
      spawnSync(process.execPath, [SESSION_START_SCRIPT], { input: JSON.stringify(input), env: childEnv, encoding: "utf-8" });
    return { run, dataDir };
  }

  const sessionStart = (extra: Record<string, unknown> = {}) => ({ session_id: "sess-1", hook_event_name: "SessionStart", ...extra });

  it("prints nothing when there is no update and no notice", () => {
    const result = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify({ items: [], plan: {}, notices: [] }) }).run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  // ahood#1569: the hook used to only report a bare count ("1 installed
  // skill/agent/MCP server update(s) are available") -- it now names what's
  // actually out of date, as `owner/slug installed→latest`, so the agent
  // (and the user it relays to) knows what it's being asked to sync.
  it("names a single update as owner/slug installed→latest", () => {
    const status = {
      items: [{ owner: "alexkay", slug: "ahood", update_available: true, installed_version: "2.7.0", latest_version: "2.8.0" }],
      plan: {},
      notices: [],
    };
    const result = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify(status) }).run();
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe(
      "ahood: updates available: alexkay/ahood 2.7.0→2.8.0. Tell the user in one line and suggest `/ahood sync` (and `npx @ahood/cli@latest setup` for the CLI); never run them yourself.",
    );
  });

  // Four updates: only the first 3 are named, and "and N more" covers the rest.
  it('names up to 3 updates and says "and N more" for the rest', () => {
    const item = (slug: string) => ({ owner: "alice", slug, update_available: true, installed_version: "1.0.0", latest_version: "1.1.0" });
    const status = { items: [item("s1"), item("s2"), item("s3"), item("s4")], plan: {}, notices: [] };
    const result = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify(status) }).run();
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "updates available: alice/s1 1.0.0→1.1.0, alice/s2 1.0.0→1.1.0, alice/s3 1.0.0→1.1.0, and 1 more.",
    );
    expect(out.hookSpecificOutput.additionalContext).not.toContain("s4");
  });

  // ahood#1569: the client-update line (`ahood.client.update_available`,
  // set by the server on `status --json`'s additive `ahood` block) is
  // reported even with no installed-item updates and no notices.
  it("reports the CLI's own update when ahood.client.update_available is set, with no items or notices", () => {
    const status = {
      items: [],
      plan: {},
      notices: [],
      ahood: { client: { update_available: true, version: "0.20.0", latest: "0.21.0" } },
    };
    const result = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify(status) }).run();
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext).toBe(
      "ahood: ahood CLI 0.20.0 → 0.21.0. Tell the user in one line and suggest `/ahood sync` (and `npx @ahood/cli@latest setup` for the CLI); never run them yourself.",
    );
  });

  // The relay instruction appears exactly once, not once up front and once
  // at the end (ahood#1569's second complaint about the first cut).
  it("states the relay instruction exactly once", () => {
    const status = { items: [{ owner: "alice", slug: "x", update_available: true, installed_version: "1.0.0", latest_version: "1.1.0" }], plan: {}, notices: [] };
    const result = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify(status) }).run();
    const out = JSON.parse(result.stdout);
    const occurrences = out.hookSpecificOutput.additionalContext.match(/one line/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("surfaces the highest-severity notice", () => {
    const status = {
      items: [],
      plan: {},
      notices: [
        { id: "a", kind: "new_feature", severity: "info", message: "low", action: { label: "x", url: "https://x" } },
        { id: "b", kind: "client_update", severity: "required", message: "upgrade now", action: { label: "Update", command: "npx @ahood/cli@latest setup" } },
      ],
    };
    const result = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify(status) }).run();
    const out = JSON.parse(result.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("Notice (required): upgrade now");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("low");
  });

  it("asks at most once per 24h: the second run in the same window prints nothing even though an update exists", () => {
    const status = { items: [{ update_available: true }], plan: {}, notices: [] };
    const { run } = runHook({}, sessionStart(), { exit: 0, stdout: JSON.stringify(status) });
    expect(run().stdout).not.toBe("");
    expect(run().stdout).toBe("");
  });

  it("fails silently when the CLI call fails (no token, network down, non-zero exit)", () => {
    const result = runHook({}, sessionStart(), { exit: 1, stdout: "" }).run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("fails silently on a malformed status response", () => {
    const result = runHook({}, sessionStart(), { exit: 0, stdout: "not json" }).run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("ignores a non-SessionStart event and bad stdin, still exiting 0", () => {
    expect(runHook({}, sessionStart({ hook_event_name: "Stop" }), { exit: 0, stdout: "{}" }).run().stdout).toBe("");
    const bad = spawnSync(process.execPath, [SESSION_START_SCRIPT], { input: "not json", encoding: "utf-8" });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");
  });

  it("shells out through the pinned CLI version, not a bare `ahood`", () => {
    const source = readFileSync(SESSION_START_SCRIPT, "utf-8");
    expect(source).toContain(`@ahood/cli@${CLI_VERSION}`);
    expect(source).not.toMatch(/execFileSync\("ahood"/);
  });
});

describe("hooks/snap-prompt.mjs", () => {
  it("is off by default: prints nothing and exits 0", () => {
    const { run, dataDir } = runHook({}, stop());
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it.each(["0", "true", "yes", ""])("stays off for AHOOD_SNAP_HOOK=%j", (value) => {
    const result = runHook({ AHOOD_SNAP_HOOK: value }, stop()).run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("on, blocks the first stop with the draft-and-ask instruction", () => {
    const result = runHook({ AHOOD_SNAP_HOOK: "1" }, stop()).run();
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("ask whether to save it");
    expect(out.reason).toContain("Save only on the user's explicit yes");
    expect(out.reason).toContain("Do not save it in this turn");
  });

  it("on, asks at most once per session", () => {
    const { run } = runHook({ AHOOD_SNAP_HOOK: "1" }, stop());
    expect(JSON.parse(run().stdout).decision).toBe("block");
    expect(run().stdout).toBe("");
  });

  it("on, never blocks while stop_hook_active is true (no loop)", () => {
    const result = runHook({ AHOOD_SNAP_HOOK: "1" }, stop({ stop_hook_active: true })).run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("on, ignores non-Stop events and bad input, still exiting 0", () => {
    expect(runHook({ AHOOD_SNAP_HOOK: "1" }, stop({ hook_event_name: "SubagentStop" })).run().stdout).toBe("");
    const bad = spawnSync(process.execPath, [SCRIPT], { input: "not json", env: { AHOOD_SNAP_HOOK: "1" }, encoding: "utf-8" });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toBe("");
  });

  it("cannot reach the network or run the CLI: it imports node:fs, node:os, node:path and node:url only", () => {
    const source = readFileSync(SCRIPT, "utf-8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["node:fs", "node:os", "node:path", "node:url"]);
    expect(source).not.toMatch(/\bfetch\(|node:http|node:https|node:net|child_process|import\(/);
  });
});

describe("skills/using-ahood/SKILL.md", () => {
  const skill = readFileSync(join(PLUGIN, "skills", "using-ahood", "SKILL.md"), "utf-8");

  it("does not take the /ahood command's name (skills and commands share a namespace)", () => {
    expect(skill).toMatch(/^---\nname: using-ahood\ndescription: .+\n---\n/);
  });

  it("carries the snap capture moments, the privacy note and the never-auto-sync rule", () => {
    expect(skill).toContain("right after you hand over a deliverable, and right after the\nuser corrects you");
    expect(skill).toContain("Snaps are private to you");
    expect(skill).toContain("Never sync on your own.");
    expect(skill).toContain("Never save a snap the user has not seen");
  });
});
