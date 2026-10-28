import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { sync, diffFileMaps } from "../src/commands/sync.js";
import { add } from "../src/commands/add.js";
import { readInstalled, updateInstalled } from "../src/installed.js";
import { readLockfile } from "../src/lockfile.js";
import { UsageError } from "../src/usage-error.js";
import { fakeRegistry, tarGz, type Entry } from "./helpers/fake-registry.js";
import { captureConsole, setupEnv, statusFrom, stubMeApi } from "./helpers/me-env.js";

vi.mock("../src/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/confirm.js")>()),
  confirmYesNo: vi.fn(async () => false),
  isInteractive: vi.fn(() => false),
}));
const confirmMod = await import("../src/confirm.js");
const confirmYesNo = vi.mocked(confirmMod.confirmYesNo);
const isInteractive = vi.mocked(confirmMod.isInteractive);

async function skillEntry(version: string, files: Record<string, string>): Promise<Entry> {
  return { kind: "skill", version, archive: await tarGz(files), rootDoc: "SKILL.md" };
}

const V1 = { "SKILL.md": "---\nname: pdf\ndescription: d\n---\nold body\n", "scripts/run.sh": "echo old\n" };
const V2 = { "SKILL.md": "---\nname: pdf\ndescription: d\n---\nnew body\n", "notes.md": "added\n" };
const SKILL = ".claude/skills/alice@pdf-tools";

describe("ahood sync (ahood#979)", () => {
  let env: ReturnType<typeof setupEnv>;
  let io: ReturnType<typeof captureConsole>;
  let entries: Record<string, Entry>;
  let registryCalls: ReturnType<typeof fakeRegistry>;

  beforeEach(async () => {
    env = setupEnv();
    io = captureConsole();
    entries = { "alice/pdf-tools": await skillEntry("1.0.0", V1) };
    registryCalls = fakeRegistry(entries);
    await add(["alice/pdf-tools"]);
    entries["alice/pdf-tools"] = await skillEntry("1.1.0", V2);
    stubMeApi(statusFrom({ "alice/pdf-tools": { kind: "skill", latest: "1.1.0" } }));
    registryCalls.length = 0;
    io.out.length = 0;
    isInteractive.mockReturnValue(false);
    confirmYesNo.mockResolvedValue(false);
  });
  afterEach(() => env.restore());

  const downloads = () => registryCalls.filter((c) => c.url.includes("/download"));

  it("refuses without a terminal and without --yes, before downloading anything", async () => {
    const error = await sync([]).catch((e) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toContain("will not update without consent");
    expect(error.message).toContain("alice/pdf-tools 1.0.0 -> 1.1.0");
    expect(error.message).toContain("--yes");
    expect(downloads()).toEqual([]);
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf-8")).toContain("old body");
  });

  it("--json without --yes refuses too (nobody to ask), even in a terminal", async () => {
    isInteractive.mockReturnValue(true);
    await expect(sync(["--json"])).rejects.toThrow(/--json leaves no terminal/);
    expect(confirmYesNo).not.toHaveBeenCalled();
  });

  it("--dry-run shows a unified diff and changes nothing", async () => {
    await sync(["--dry-run"]);
    const text = io.stdout();
    expect(text).toContain("alice/pdf-tools: 1.0.0 -> 1.1.0");
    expect(text).toContain("-old body");
    expect(text).toContain("+new body");
    expect(text).toContain("+++ notes.md");
    expect(text).toContain("--- scripts/run.sh");
    expect(text).toContain("nothing was changed");
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf-8")).toContain("old body");
    expect(readInstalled().items[0].version).toBe("1.0.0");
  });

  it("--dry-run --json reports would_update with the diff", async () => {
    await sync(["--dry-run", "--json"]);
    const { results } = JSON.parse(io.out.at(-1)!);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ owner: "alice", slug: "pdf-tools", from: "1.0.0", to: "1.1.0", action: "would_update" });
    expect(results[0].diff).toContain("+new body");
  });

  it("asks y/N per artifact in a terminal; N leaves everything as it was", async () => {
    isInteractive.mockReturnValue(true);
    await sync([]);
    expect(confirmYesNo).toHaveBeenCalledWith("Update alice/pdf-tools to 1.1.0? [y/N] ");
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf-8")).toContain("old body");
    expect(io.stdout()).toContain("0 updated, 1 declined, 0 failed");
  });

  it("y applies it: files replaced (removed files gone), project lockfile and installed.json moved", async () => {
    isInteractive.mockReturnValue(true);
    confirmYesNo.mockResolvedValue(true);
    await sync([]);
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf-8")).toContain("new body");
    expect(existsSync(`${SKILL}/notes.md`)).toBe(true);
    expect(existsSync(`${SKILL}/scripts/run.sh`)).toBe(false);
    expect(readLockfile(".claude/skills.lock.json")["alice/pdf-tools"].version).toBe("1.1.0");
    expect(readInstalled().items).toEqual([expect.objectContaining({ version: "1.1.0" })]);
  });

  it("--yes --json applies without asking and keeps stdout one JSON document", async () => {
    await sync(["--yes", "--json"]);
    expect(confirmYesNo).not.toHaveBeenCalled();
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0]).results[0]).toMatchObject({ action: "updated", to: "1.1.0" });
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf-8")).toContain("new body");
  });

  it("applies in the install's own project directory, whatever the cwd", async () => {
    const project = process.cwd();
    process.chdir(env.dir);
    await sync(["--yes"]);
    expect(process.cwd()).toBe(env.dir);
    expect(readFileSync(`${project}/${SKILL}/SKILL.md`, "utf-8")).toContain("new body");
  });

  it("never moves a pinned install past its pin", async () => {
    updateInstalled((f) => void (f.items[0].pinned = "1.0.0"));
    await sync(["--yes"]);
    expect(downloads()).toEqual([]);
    expect(readFileSync(`${SKILL}/SKILL.md`, "utf-8")).toContain("old body");
    expect(io.stdout()).toContain("Everything is up to date.");
  });

  it("filters by owner/slug or bare slug, and refuses an unknown target", async () => {
    await sync(["pdf-tools", "--dry-run"]);
    expect(io.stdout()).toContain("1.0.0 -> 1.1.0");
    await expect(sync(["alice/nope"])).rejects.toThrow(/Not installed.*alice\/nope/);
  });

  it("skips an artifact the registry no longer shows", async () => {
    stubMeApi(statusFrom({}));
    await sync(["--yes"]);
    expect(io.stdout()).toContain("Skipped alice/pdf-tools: not found in the registry");
    expect(downloads()).toEqual([]);
  });

  it("skips an install whose files were deleted by hand instead of resurrecting it", async () => {
    rmSync(SKILL, { recursive: true });
    await sync(["--yes"]);
    expect(io.stdout()).toContain("its files are gone");
    expect(downloads()).toEqual([]);
    expect(existsSync(SKILL)).toBe(false);
  });

  it("refuses --yes together with --dry-run, and unknown flags", async () => {
    await expect(sync(["--yes", "--dry-run"])).rejects.toThrow(/contradict/);
    await expect(sync(["--force"])).rejects.toThrow(/Unknown flag: --force/);
  });

  it("updates a single-file agent install by its AGENT.md diff", async () => {
    entries["alice/helper"] = { kind: "agent", version: "1.0.0", archive: await tarGz({ "AGENT.md": "agent v1\n" }), rootDoc: "AGENT.md" };
    await add(["alice/helper"]);
    entries["alice/helper"] = { kind: "agent", version: "2.0.0", archive: await tarGz({ "AGENT.md": "agent v2\n" }), rootDoc: "AGENT.md" };
    stubMeApi(statusFrom({ "alice/helper": { kind: "agent", latest: "2.0.0" } }));
    io.out.length = 0;
    await sync(["alice/helper", "--yes"]);
    expect(io.stdout()).toContain("-agent v1");
    expect(io.stdout()).toContain("+agent v2");
    expect(readFileSync(".claude/agents/alice@helper.md", "utf-8")).toBe("agent v2\n");
  });
});

describe("diffFileMaps", () => {
  it("reports binary files without dumping them, and skips identical files", () => {
    const same = Buffer.from("same\n");
    const diff = diffFileMaps(
      new Map([["a.txt", same], ["img.png", Buffer.from([0, 1, 2])]]),
      new Map([["a.txt", same], ["img.png", Buffer.from([0, 9, 9])]]),
      "a",
      "b",
    );
    expect(diff).toBe("Binary file img.png differs\n");
  });
});
