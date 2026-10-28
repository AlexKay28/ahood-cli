import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pin, unpin } from "../src/commands/pin.js";
import { readInstalled, recordInstall, updateInstalled } from "../src/installed.js";
import { writeLockfileEntry } from "../src/lockfile.js";
import { captureConsole, setupEnv } from "./helpers/me-env.js";

describe("ahood pin / unpin (ahood#979)", () => {
  let env: ReturnType<typeof setupEnv>;
  let io: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    env = setupEnv();
    io = captureConsole();
    recordInstall({ owner: "alice", slug: "pdf-tools", version: "1.0.0", kind: "skill", checksum_sha256: "c" });
  });
  afterEach(() => env.restore());

  it("pins at the installed version by default", async () => {
    await pin(["alice/pdf-tools"]);
    expect(readInstalled().items[0].pinned).toBe("1.0.0");
    expect(io.stdout()).toContain("Pinned alice/pdf-tools at 1.0.0");
  });

  it("pins at an explicit @version, across every install of it", async () => {
    updateInstalled((f) => f.items.push({ ...f.items[0], projectDir: "/other", installedPath: "/other/p" }));
    await pin(["alice/pdf-tools@0.9.0", "--json"]);
    expect(readInstalled().items.map((i) => i.pinned)).toEqual(["0.9.0", "0.9.0"]);
    expect(JSON.parse(io.out[0])).toMatchObject({ owner: "alice", slug: "pdf-tools", installs: [{ pinned: "0.9.0" }, { pinned: "0.9.0" }] });
  });

  it("unpin removes it", async () => {
    await pin(["alice/pdf-tools"]);
    await unpin(["alice/pdf-tools", "--json"]);
    expect(readInstalled().items[0].pinned).toBeUndefined();
    expect(JSON.parse(io.out.at(-1)!)).toEqual({ owner: "alice", slug: "pdf-tools", unpinned: 1 });
  });

  it("sees installs only the project lockfile knows about (lazy migration)", async () => {
    writeLockfileEntry(".claude/skills.lock.json", "bob/legacy", { version: "2.0.0", checksum_sha256: "c" });
    await pin(["bob/legacy"]);
    expect(readInstalled().items.find((i) => i.slug === "legacy")?.pinned).toBe("2.0.0");
  });

  it("refuses something not installed, a bad version, and a version on unpin", async () => {
    await expect(pin(["alice/nope"])).rejects.toThrow(/not installed/);
    await expect(pin(["alice/pdf-tools@latest"])).rejects.toThrow(/Invalid version/);
    await expect(unpin(["alice/pdf-tools@1.0.0"])).rejects.toThrow(/unpin takes no version/);
    await expect(pin([])).rejects.toThrow(/Usage: ahood pin/);
  });
});
