import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { extractSingleFileContent, extractTarGz } from "../src/commands/add.js";
import { isCanonicalEntryPath } from "../src/archive-entries.js";

// AlexKay28/ahood#792: `SKILL.md` and `././SKILL.md` were two keys to the
// server (which reads the FIRST entry) but one file to extractTarGz (which
// wrote them in order, so the LAST won). These pin that the CLI refuses such
// an archive before writing anything, using the same canonical-path rule as
// the server's lib/publish/entry-path.ts.

function tarGzEntries(files: Array<[string, string]>): Promise<Buffer> {
  const tar = pack();
  for (const [name, content] of files) {
    tar.entry({ name }, content);
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolvePromise, reject) => {
    tar.on("data", (chunk) => chunks.push(chunk as Buffer));
    tar.on("end", () => resolvePromise(gzipSync(Buffer.concat(chunks))));
    tar.on("error", reject);
  });
}

describe("isCanonicalEntryPath", () => {
  it("accepts plain relative POSIX paths", () => {
    for (const path of ["SKILL.md", "scripts/run.sh", "a/b/c.txt", ".hidden", "a/.b"]) {
      expect(isCanonicalEntryPath(path), path).toBe(true);
    }
  });

  it("rejects every alias and escape shape", () => {
    for (const path of ["", "./SKILL.md", "././SKILL.md", "a//b", "a/./b", "a/../b", "../x", "a/", "/etc/passwd", "a\\b", "a\0b", ".", ".."]) {
      expect(isCanonicalEntryPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe("extractTarGz entry-path guard (#792)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-entries-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses SKILL.md + ././SKILL.md and writes nothing", async () => {
    const archive = await tarGzEntries([
      ["SKILL.md", "# reviewed\n"],
      ["././SKILL.md", "# hidden\n"],
    ]);
    const dest = join(dir, "dest");

    await expect(extractTarGz(archive, dest)).rejects.toThrow(/unsafe archive entry/);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses two entries with the same canonical path and writes nothing", async () => {
    const archive = await tarGzEntries([
      ["SKILL.md", "# reviewed\n"],
      ["./SKILL.md", "# hidden\n"],
    ]);
    const dest = join(dir, "dest");

    await expect(extractTarGz(archive, dest)).rejects.toThrow(/more than one entry for "SKILL.md"/);
    expect(existsSync(dest)).toBe(false);
  });

  it("checks every entry before writing the first one", async () => {
    // The bad entry is LAST, so a guard that ran per-entry while writing
    // would already have put SKILL.md on disk.
    const archive = await tarGzEntries([
      ["SKILL.md", "# reviewed\n"],
      ["a//b", "x\n"],
    ]);
    const dest = join(dir, "dest");

    await expect(extractTarGz(archive, dest)).rejects.toThrow(/unsafe archive entry/);
    expect(existsSync(dest)).toBe(false);
  });

  for (const name of ["a//b", "a/./b", "a\\b", "/abs/x"]) {
    it(`refuses the non-canonical entry ${JSON.stringify(name)}`, async () => {
      const archive = await tarGzEntries([
        ["SKILL.md", "# ok\n"],
        [name, "x\n"],
      ]);
      const dest = join(dir, "dest");

      await expect(extractTarGz(archive, dest)).rejects.toThrow(/unsafe archive entry/);
      expect(existsSync(dest)).toBe(false);
    });
  }

  it("still installs a real `tar -C dir .` archive (./ prefixes and directory entries)", () => {
    const src = join(dir, "src");
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "# demo\n");
    writeFileSync(join(src, "scripts", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const tarball = join(dir, "skill.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", src, "."]);
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf-8" });
    // Guard against a tar that stops emitting the shape this test is about.
    expect(listing).toContain("./\n");
    expect(listing).toContain("./scripts/\n");

    const dest = join(dir, "dest");
    return extractTarGz(readFileSync(tarball), dest).then(() => {
      expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toBe("# demo\n");
      expect(readFileSync(join(dest, "scripts", "run.sh"), "utf-8")).toBe("#!/bin/sh\n");
      expect(statSync(join(dest, "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    });
  });
});

describe("extractSingleFileContent entry-path guard (#792)", () => {
  it("refuses a duplicate root doc instead of picking one", async () => {
    const archive = await tarGzEntries([
      ["AGENT.md", "# first\n"],
      ["./AGENT.md", "# second\n"],
    ]);

    await expect(extractSingleFileContent(archive, "AGENT.md")).rejects.toThrow(/more than one entry for "AGENT.md"/);
  });

  it("refuses a non-canonical entry even when it is not the one asked for", async () => {
    const archive = await tarGzEntries([
      ["AGENT.md", "# agent\n"],
      ["notes/./AGENT.md", "x\n"],
    ]);

    await expect(extractSingleFileContent(archive, "AGENT.md")).rejects.toThrow(/unsafe archive entry/);
  });
});
