// ahood#981: the opt-in snap Stop hook (plugins/ahood/hooks) and the plugin skill.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PLUGIN_DIR } from "../src/setup/templates/claude-plugin.js";

const PLUGIN = join(import.meta.dirname, "..", CLAUDE_PLUGIN_DIR);
const SCRIPT = join(PLUGIN, "hooks", "snap-prompt.mjs");

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
  it("registers one Stop command hook that runs the bundled script, and nothing else", () => {
    const config = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf-8"));
    expect(Object.keys(config)).toEqual(["hooks"]);
    expect(Object.keys(config.hooks)).toEqual(["Stop"]);
    expect(config.hooks.Stop).toHaveLength(1);
    const [group] = config.hooks.Stop;
    expect(group.matcher).toBeUndefined(); // Stop takes no matcher
    expect(group.hooks).toEqual([
      { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/snap-prompt.mjs"', timeout: 10 },
    ]);
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
