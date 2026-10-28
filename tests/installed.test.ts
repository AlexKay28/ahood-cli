import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { add } from "../src/commands/add.js";
import { remove } from "../src/commands/remove.js";
import { installedFilePath, migrateProjectLockfile, readInstalled, recordInstall, updateInstalled } from "../src/installed.js";
import { writeLockfileEntry } from "../src/lockfile.js";
import { entry, fakeRegistry } from "./helpers/fake-registry.js";
import { captureConsole, setupEnv } from "./helpers/me-env.js";

describe("~/.ahood/installed.json (ahood#979)", () => {
  let env: ReturnType<typeof setupEnv>;
  beforeEach(() => {
    env = setupEnv();
    captureConsole();
  });
  afterEach(() => env.restore());

  it("defaults to ~/.ahood/installed.json and honours AHOOD_INSTALLED_FILE", () => {
    expect(installedFilePath()).toBe(env.installedFile);
    delete process.env.AHOOD_INSTALLED_FILE;
    expect(installedFilePath()).toBe(join(homedir(), ".ahood", "installed.json"));
  });

  it("a skill install records {owner, slug, version, kind, installedPath, installedAt}", async () => {
    fakeRegistry({ "alice/pdf-tools": await entry("skill", "1.0.0") });
    await add(["alice/pdf-tools"]);
    const file = env.readInstalledJson();
    expect(file.version).toBe(1);
    expect(file.items).toHaveLength(1);
    const item = file.items[0];
    expect(item).toMatchObject({
      owner: "alice",
      slug: "pdf-tools",
      version: "1.0.0",
      kind: "skill",
      installedPath: resolve(".claude/skills/alice@pdf-tools"),
      projectDir: process.cwd(),
    });
    expect(Number.isNaN(Date.parse(item.installedAt))).toBe(false);
    expect(item.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records agent and doc installs at their own paths", async () => {
    fakeRegistry({ "alice/helper": await entry("agent"), "alice/guide": await entry("doc") });
    await add(["alice/helper"]);
    await add(["alice/guide"], { noun: "doc", kind: "doc" });
    const items = readInstalled().items;
    expect(items.map((i) => [i.kind, i.installedPath])).toEqual([
      ["agent", resolve(".claude/agents/alice@helper.md")],
      ["doc", resolve(".claude/docs/alice@guide.md")],
    ]);
  });

  it("a re-install replaces the entry but keeps its pin", async () => {
    const entries = { "alice/pdf-tools": await entry("skill", "1.0.0") };
    fakeRegistry(entries);
    await add(["alice/pdf-tools"]);
    updateInstalled((f) => void (f.items[0].pinned = "1.0.0"));
    entries["alice/pdf-tools"] = await entry("skill", "1.1.0");
    await add(["alice/pdf-tools"]);
    const items = readInstalled().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ version: "1.1.0", pinned: "1.0.0" });
  });

  it("remove drops the entry for this project only", async () => {
    fakeRegistry({ "alice/pdf-tools": await entry("skill") });
    await add(["alice/pdf-tools"]);
    recordInstall({ owner: "alice", slug: "pdf-tools", version: "1.0.0", kind: "skill", checksum_sha256: "x" });
    updateInstalled((f) => f.items.push({ ...f.items[0], projectDir: "/elsewhere", installedPath: "/elsewhere/x" }));
    await remove(["alice/pdf-tools", "--yes"]);
    expect(readInstalled().items.map((i) => i.projectDir)).toEqual(["/elsewhere"]);
  });

  it("lazily migrates pins from the current project's lockfile, once", () => {
    mkdirSync(".claude/skills/alice@old", { recursive: true });
    writeLockfileEntry(".claude/skills.lock.json", "alice/old", { version: "0.9.0", checksum_sha256: "c" });
    writeLockfileEntry(".claude/skills.lock.json", "alice/guide", { version: "1.0.0", checksum_sha256: "d", kind: "doc" });
    expect(migrateProjectLockfile()).toBe(2);
    expect(migrateProjectLockfile()).toBe(0);
    const items = readInstalled().items;
    expect(items.map((i) => [i.owner, i.slug, i.version, i.kind, i.migrated])).toEqual([
      ["alice", "old", "0.9.0", "skill", true],
      ["alice", "guide", "1.0.0", "doc", true],
    ]);
  });

  it("migration is a no-op (and writes nothing) outside a project", () => {
    expect(migrateProjectLockfile()).toBe(0);
    expect(existsSync(env.installedFile)).toBe(false);
  });

  it("refuses a corrupted file instead of overwriting it", () => {
    mkdirSync(join(env.installedFile, ".."), { recursive: true });
    writeFileSync(env.installedFile, "{ not json");
    expect(() => readInstalled()).toThrow(/corrupted/);
  });

  it("a failed record never fails the install itself", async () => {
    mkdirSync(join(env.installedFile, ".."), { recursive: true });
    writeFileSync(env.installedFile, "{ not json");
    fakeRegistry({ "alice/pdf-tools": await entry("skill") });
    await add(["alice/pdf-tools"]);
    expect(existsSync(".claude/skills/alice@pdf-tools/SKILL.md")).toBe(true);
  });
});
