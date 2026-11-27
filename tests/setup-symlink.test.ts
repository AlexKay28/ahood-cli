import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/confirm.js", async (orig) => ({
  ...(await orig<typeof import("../src/confirm.js")>()),
  isInteractive: vi.fn(() => false),
  confirmYesNo: vi.fn(async () => true),
  askLine: vi.fn(async () => ""),
}));
vi.mock("../src/commands/login.js", () => ({ login: vi.fn(async () => {}) }));

import { applyChanges } from "../src/setup/file-changes.js";
import { setup } from "../src/setup/setup-command.js";
import { captureConsole } from "./helpers/me-env.js";
import { fakeOpencode, fakeRunner, setupHomeEnv } from "./helpers/harness-env.js";

let env: ReturnType<typeof setupHomeEnv>;
let runner: ReturnType<typeof fakeRunner>;
beforeEach(() => {
  env = setupHomeEnv();
  captureConsole();
  runner = fakeRunner({ opencode: fakeOpencode() });
});
afterEach(() => {
  runner.restore();
  env.restore();
});

// ahood-cli#254: setup used to rename its temp file onto the link, replacing a
// dotfiles-managed symlink with a regular file and leaving the target stale.
describe("setup writes through symlinked configs (ahood-cli#254)", () => {
  const isLink = (p: string) => lstatSync(p).isSymbolicLink();
  const tmpLeft = (dir: string) => readdirSync(dir).filter((f) => f.includes(".tmp-"));

  it("setup and --remove opencode keep the link and update its target", async () => {
    const dotfiles = mkdtempSync(join(tmpdir(), "ahood-254-"));
    try {
      const target = join(dotfiles, "opencode.json");
      writeFileSync(target, '{\n  "theme": "dark"\n}\n');
      const dir = join(env.home, ".config", "opencode");
      mkdirSync(dir, { recursive: true });
      const link = join(dir, "opencode.json");
      symlinkSync(target, link);

      await setup(["opencode", "--yes"]);
      expect(isLink(link)).toBe(true);
      expect(readFileSync(target, "utf-8")).toContain("api/mcp");
      expect(readFileSync(target, "utf-8")).toContain('"theme"');

      await setup(["--remove", "opencode", "--yes"]);
      expect(isLink(link)).toBe(true);
      expect(readFileSync(target, "utf-8")).not.toContain("api/mcp");
      expect(readFileSync(target, "utf-8")).toContain('"theme"');
      expect(tmpLeft(dotfiles)).toEqual([]);
    } finally {
      rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  it("applyChanges: link survives, explicit mode lands on the target, existing mode kept otherwise", () => {
    const dotfiles = mkdtempSync(join(tmpdir(), "ahood-254-"));
    try {
      const target = join(dotfiles, "config.toml");
      writeFileSync(target, "a = 1\n");
      chmodSync(target, 0o644);
      const link = join(env.home, "config.toml");
      symlinkSync(target, link);
      applyChanges([{ path: link, before: "a = 1\n", after: "a = 2\n", what: "cfg", mode: 0o600 }], { dryRun: false, stamp: "s" });
      expect(isLink(link)).toBe(true);
      expect(readFileSync(target, "utf-8")).toBe("a = 2\n");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      chmodSync(target, 0o640);
      applyChanges([{ path: link, before: "a = 2\n", after: "a = 3\n", what: "cfg" }], { dryRun: false, stamp: "s2" });
      expect(statSync(target).mode & 0o777).toBe(0o640);
      expect(tmpLeft(dotfiles)).toEqual([]);
    } finally {
      rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  it("cleans up the temp file when the write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahood-254-"));
    try {
      // A directory at the destination makes the final rename fail after the temp file exists.
      const dest = join(dir, "config.toml");
      mkdirSync(join(dest, "sub"), { recursive: true });
      expect(() => applyChanges([{ path: dest, before: null, after: "x\n", what: "cfg" }], { dryRun: false, stamp: "s" })).toThrow();
      expect(readdirSync(dir)).toEqual(["config.toml"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
