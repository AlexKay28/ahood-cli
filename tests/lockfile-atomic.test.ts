import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  onReaddir: null as null | ((path: unknown) => void),
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
    // Same pass-through shape as renameSync above, so the #125 sweep's own
    // directory listing can be made to fail on demand.
    readdirSync: ((path: unknown, options: unknown) => {
      hooks.onReaddir?.(path);
      return (actual.readdirSync as (...args: unknown[]) => unknown)(path, options);
    }) as unknown as typeof actual.readdirSync,
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
    hooks.onReaddir = null;
    dir = mkdtempSync(join(tmpdir(), "ahood-atomic-test-"));
    target = join(dir, ".mcp.json");
  });

  afterEach(() => {
    hooks.onRename = null;
    hooks.onReaddir = null;
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

  describe("stale temp file sweep (#125)", () => {
    // A process that has already exited by the time spawnSync returns -- its
    // pid is dead (barring immediate pid reuse), standing in for an ahood run
    // hard-killed (SIGKILL/OOM/power loss) between the write and the rename,
    // where the `finally` cleanup from #119 never got to run.
    function deadPid(): number {
      const child = spawnSync(process.execPath, ["-e", ""]);
      if (!child.pid) throw new Error("could not spawn a throwaway process");
      return child.pid;
    }

    function seed(name: string, contents = '{"mcpServers":{"demo":{"env":{"API_KEY":"s3cret"}}}}\n'): string {
      const path = join(dir, name);
      writeFileSync(path, contents, { mode: 0o600 });
      return path;
    }

    it("removes an orphan whose writer is gone", () => {
      const orphan = seed(`.mcp.json.tmp-${deadPid()}-424242424242424242`);

      writeJsonFileAtomic(target, { mcpServers: {} });

      expect(existsSync(orphan)).toBe(false);
      expect(tempFiles(dir)).toEqual([]);
    });

    it("leaves a temp file alone while its writer is still alive", () => {
      // This process's own pid: an ahood run that is mid-write right now, whose
      // temp file must survive somebody else's concurrent successful write.
      const live = seed(`.mcp.json.tmp-${process.pid}-131313131313131313`);

      writeJsonFileAtomic(target, { mcpServers: {} });

      expect(existsSync(live)).toBe(true);
    });

    it("leaves files that only look like temp names alone, whatever the pid would be", () => {
      const impostors = [
        ".mcp.json.tmp-notapid-1",
        ".mcp.json.tmp-1",
        `.mcp.json.tmp-${deadPid()}`,
        `.mcp.json.tmp-${deadPid()}-1-2`,
        `.mcp.json.tmp-${deadPid()}-`,
        `.mcp.json.tmp-${deadPid()}-1x`,
        ".mcp.json.tmp-0-1",
        ".mcp.json.tmp--1-1",
      ].map((name) => seed(name, "not ours\n"));

      writeJsonFileAtomic(target, { mcpServers: {} });

      for (const path of impostors) expect(existsSync(path)).toBe(true);
    });

    it("does not reach across to another destination's temp files", () => {
      const other = seed(`skills.lock.json.tmp-${deadPid()}-555555555555555555`);

      writeJsonFileAtomic(target, { mcpServers: {} });

      expect(existsSync(other)).toBe(true);
    });

    it("does not fail the write when the sweep itself fails", () => {
      seed(`.mcp.json.tmp-${deadPid()}-777777777777777777`);
      hooks.onReaddir = () => {
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      };

      expect(() => writeJsonFileAtomic(target, { mcpServers: { demo: { command: "node" } } })).not.toThrow();

      // Unhook before asserting -- this test file's own helpers read the
      // directory through the same mocked readdirSync.
      hooks.onReaddir = null;
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ mcpServers: { demo: { command: "node" } } });
    });
  });

  // The contract from ahood-cli#144: a symlinked .mcp.json is written THROUGH,
  // onto whatever the link resolves to. `outside` stands in for the shared or
  // out-of-tree config someone symlinks at precisely so the MCP server secrets
  // never land in the project directory.
  describe("symlinked destination (#144)", () => {
    let outside: string;
    const secrets = { mcpServers: { demo: { env: { API_KEY: "s3cret" } } } };

    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "ahood-atomic-outside-"));
    });

    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    it("writes onto the link's target and leaves the link a link", () => {
      const real = join(outside, "real.json");
      writeFileSync(real, '{"mcpServers":{}}\n');
      chmodSync(real, 0o640);
      symlinkSync(real, target);

      writeJsonFileAtomic(target, secrets);

      // The content reached the file the user pointed at...
      expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual(secrets);
      // ...and the arrangement survived: still a symlink, not a regular file
      // quietly holding the secrets inside the project directory.
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect((statSync(real).mode & 0o777).toString(8)).toBe("640");
      expect(readdirSync(dir)).toEqual([".mcp.json"]);
      expect(tempFiles(dir)).toEqual([]);
      expect(tempFiles(outside)).toEqual([]);
    });

    it("puts the temp file beside the resolved target, so the rename never crosses filesystems", () => {
      const real = join(outside, "real.json");
      writeFileSync(real, '{"mcpServers":{}}\n');
      symlinkSync(real, target);

      let renamed: [string, string] | undefined;
      hooks.onRename = (oldPath, newPath) => {
        renamed = [oldPath, newPath];
      };

      writeJsonFileAtomic(target, secrets);

      expect(renamed).toBeDefined();
      // Same directory on both sides of the rename -- an out-of-tree target on
      // another mount would be EXDEV otherwise.
      expect(dirname(renamed![0])).toBe(outside);
      expect(renamed![1]).toBe(real);
    });

    it("creates the target of a dangling symlink rather than replacing the link", () => {
      const real = join(outside, "not-yet.json");
      symlinkSync(real, target);
      const reference = join(outside, "reference.json");
      writeFileSync(reference, "{}\n");

      writeJsonFileAtomic(target, secrets);

      expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual(secrets);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      // Nothing to preserve at a destination that didn't exist, so it lands at
      // the umask default, exactly as a brand-new regular destination does.
      expect(statSync(real).mode & 0o777).toBe(statSync(reference).mode & 0o777);
    });

    it("follows a chain of links to the file at the end of it", () => {
      const real = join(outside, "real.json");
      const middle = join(outside, "middle.json");
      writeFileSync(real, '{"mcpServers":{}}\n');
      symlinkSync(real, middle);
      symlinkSync(middle, target);

      writeJsonFileAtomic(target, secrets);

      expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual(secrets);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(lstatSync(middle).isSymbolicLink()).toBe(true);
    });

    it("refuses a link that loops back on itself instead of spinning", () => {
      const other = join(outside, "loop.json");
      symlinkSync(other, target);
      symlinkSync(target, other);

      expect(() => writeJsonFileAtomic(target, secrets)).toThrow(/loops back on itself/);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(tempFiles(dir)).toEqual([]);
      expect(tempFiles(outside)).toEqual([]);
    });

    it("sweeps orphaned temp files from both the target's directory and the link's (#125)", () => {
      const child = spawnSync(process.execPath, ["-e", ""]);
      if (!child.pid) throw new Error("could not spawn a throwaway process");
      const real = join(outside, "real.json");
      writeFileSync(real, '{"mcpServers":{}}\n');
      symlinkSync(real, target);
      // Left by a crashed write under this fix (beside the target) and by one
      // under a pre-#144 version (beside the link) respectively.
      const besideTarget = join(outside, `real.json.tmp-${child.pid}-424242424242424242`);
      const besideLink = join(dir, `.mcp.json.tmp-${child.pid}-424242424242424242`);
      for (const path of [besideTarget, besideLink]) writeFileSync(path, "{}\n", { mode: 0o600 });

      writeJsonFileAtomic(target, secrets);

      expect(existsSync(besideTarget)).toBe(false);
      expect(existsSync(besideLink)).toBe(false);
    });
  });
});
