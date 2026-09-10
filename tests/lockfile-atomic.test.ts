import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../src/lockfile.js";

// Lives in its own file because writeJsonFileAtomic's failure path can only be
// exercised by making renameSync throw, and node:fs named imports can't be
// vi.spyOn'd ("module namespace is not configurable in ESM") -- only replaced
// at the module level, which the rest of the lockfile suite (real files, a real
// child process) must not inherit. The replacement is a pass-through: every
// export stays the real one, and renameSync only diverges when a test installs
// a hook.
const hooks = vi.hoisted(() => ({
  onRename: null as null | ((oldPath: string, newPath: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    renameSync: (oldPath: string, newPath: string) => {
      hooks.onRename?.(oldPath, newPath);
      return actual.renameSync(oldPath, newPath);
    },
  };
});

const isRoot = process.getuid?.() === 0;

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

describe("writeJsonFileAtomic", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    hooks.onRename = null;
    dir = mkdtempSync(join(tmpdir(), "ahood-atomic-test-"));
    target = join(dir, ".mcp.json");
  });

  afterEach(() => {
    hooks.onRename = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file and leaves no temp file behind", () => {
    writeJsonFileAtomic(target, { mcpServers: { demo: { command: "node" } } });

    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ mcpServers: { demo: { command: "node" } } });
    expect(readFileSync(target, "utf-8").endsWith("\n")).toBe(true);
    expect(tempFiles(dir)).toEqual([]);
  });

  it("removes the temp file and rethrows the original error when rename fails (#119)", () => {
    const failure = Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), { code: "EXDEV" });
    hooks.onRename = () => {
      throw failure;
    };

    let caught: unknown;
    try {
      writeJsonFileAtomic(target, { mcpServers: { demo: { env: { API_KEY: "s3cret" } } } });
    } catch (error) {
      caught = error;
    }

    // The unlink is best-effort precisely so it can't replace the real reason
    // the write failed -- same instance, same message, same errno code.
    expect(caught).toBe(failure);
    expect((caught as NodeJS.ErrnoException).code).toBe("EXDEV");
    // No orphaned *.tmp-* copy of the secrets left in the project directory.
    expect(tempFiles(dir)).toEqual([]);
  });

  it.skipIf(isRoot)("keeps the temp file unreadable by group and other while it exists (#119)", () => {
    writeFileSync(target, "{}\n");
    chmodSync(target, 0o644);

    let tmpMode: number | undefined;
    hooks.onRename = (oldPath) => {
      tmpMode = statSync(oldPath).mode & 0o777;
    };

    writeJsonFileAtomic(target, { mcpServers: { demo: { env: { API_KEY: "s3cret" } } } });

    expect(tmpMode).toBe(0o600);
  });

  it("preserves the destination's existing mode across the write (#119, ahood#169)", () => {
    writeFileSync(target, "{}\n");
    chmodSync(target, 0o644);

    writeJsonFileAtomic(target, { mcpServers: {} });

    expect((statSync(target).mode & 0o777).toString(8)).toBe("644");
  });

  it("preserves a non-default destination mode too, rather than normalizing it", () => {
    writeFileSync(target, "{}\n");
    chmodSync(target, 0o600);

    writeJsonFileAtomic(target, { mcpServers: {} });

    expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
  });

  it("gives a brand-new file the umask default, unchanged from a plain writeFileSync", () => {
    const reference = join(dir, "reference.json");
    writeFileSync(reference, "{}\n");

    writeJsonFileAtomic(target, { mcpServers: {} });

    expect(statSync(target).mode & 0o777).toBe(statSync(reference).mode & 0o777);
  });
});
