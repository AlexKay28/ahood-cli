import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLockfile, writeLockfileEntry, removeLockfileEntry } from "../src/lockfile.js";

describe("lockfile", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-lock-test-"));
    lockPath = join(dir, ".claude", "skills.lock.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty object when no lockfile exists", () => {
    expect(readLockfile(lockPath)).toEqual({});
  });

  it("writes and reads back an entry", () => {
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc123" });
    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc123" },
    });
  });

  it("preserves other entries when writing a new one", () => {
    writeLockfileEntry(lockPath, "alice/skill-a", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "bob/skill-b", { version: "2.0.0", checksum_sha256: "bbb" });
    expect(Object.keys(readLockfile(lockPath))).toEqual(["alice/skill-a", "bob/skill-b"]);
  });

  it("overwrites an existing entry for the same skill (used by update)", () => {
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.1.0", checksum_sha256: "bbb" });
    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.1.0", checksum_sha256: "bbb" },
    });
  });

  it("removeLockfileEntry deletes exactly the named entry", () => {
    writeLockfileEntry(lockPath, "alice/skill-a", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "bob/skill-b", { version: "2.0.0", checksum_sha256: "bbb" });
    removeLockfileEntry(lockPath, "alice/skill-a");
    expect(readLockfile(lockPath)).toEqual({
      "bob/skill-b": { version: "2.0.0", checksum_sha256: "bbb" },
    });
  });

  it("throws instead of silently discarding a corrupted lockfile", () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "{not valid json");
    expect(() => readLockfile(lockPath)).toThrow(/corrupted/);
  });

  it("does not lose entries across many back-to-back writes (lock acquire/release round-trips cleanly)", async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() =>
        writeLockfileEntry(lockPath, `owner/skill-${i}`, { version: "1.0.0", checksum_sha256: `hash-${i}` }),
      ),
    );
    await Promise.all(writes);
    expect(Object.keys(readLockfile(lockPath))).toHaveLength(8);
  });
});
