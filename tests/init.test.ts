import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init.js";
import { publish } from "../src/commands/publish.js";

// publish.ts's own client-side check on SKILL.md is nothing more than
// `existsSync(skillMdPath)` (see publish.ts) -- it doesn't parse frontmatter
// at all locally. So the strongest available check that `ahood init`'s
// scaffold "would pass `ahood publish`'s own validation" is to run the real
// `publish()` against a freshly-scaffolded directory, with the network layer
// stubbed the same way tests/publish.test.ts does it, and confirm it gets
// all the way through instead of failing on the "No SKILL.md found" guard
// (or anything else).
function stubPublishApi(uploadCapture: { body?: Uint8Array }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, requestInit: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/versions/init")) {
        return new Response(
          JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "http://upload.test/put") {
        uploadCapture.body = requestInit.body as Uint8Array;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/versions/complete")) {
        return new Response(JSON.stringify({ version_id: "v1", version: "1.0.0", status: "processing" }), { status: 202 });
      }
      if (/\/versions\/[^/]+$/.test(url) && !url.endsWith("/versions/init") && !url.endsWith("/versions/complete")) {
        return new Response(JSON.stringify({ version: "1.0.0", status: "published" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
    }),
  );
}

describe("init", () => {
  let dir: string;
  let originalCwd: string;
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-init-test-"));
    process.chdir(dir);
    process.env.AHOOD_API_URL = "http://ahood.test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("scaffolds a new dir + SKILL.md when a name is given", async () => {
    await init(["pdf-tools"]);

    const skillMdPath = join(dir, "pdf-tools", "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    const content = readFileSync(skillMdPath, "utf8");
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\nname: pdf-tools\n/);
    expect(content).toMatch(/\ndescription: .+\n/);
    expect(content).toContain("## Instructions");
  });

  it("scaffolds SKILL.md in the current directory when no name is given", async () => {
    await init([]);

    const skillMdPath = join(dir, "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    const content = readFileSync(skillMdPath, "utf8");
    expect(content).toMatch(/\nname: .+\n/);
    expect(content).toMatch(/\ndescription: .+\n/);
  });

  it("refuses to overwrite an existing SKILL.md", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# already here");

    await expect(init([])).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# already here");
  });

  it("refuses to overwrite an existing SKILL.md in a named target dir", async () => {
    await init(["pdf-tools"]);
    const before = readFileSync(join(dir, "pdf-tools", "SKILL.md"), "utf8");

    await expect(init(["pdf-tools"])).rejects.toThrow(/already exists/);
    expect(readFileSync(join(dir, "pdf-tools", "SKILL.md"), "utf8")).toBe(before);
  });

  it("the generated SKILL.md's frontmatter has exactly the required name/description fields, non-empty", async () => {
    await init(["pdf-tools"]);
    const content = readFileSync(join(dir, "pdf-tools", "SKILL.md"), "utf8");

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatterMatch, "expected --- delimited frontmatter").toBeTruthy();
    const frontmatter = frontmatterMatch![1];

    // Strip YAML comment lines the way a real YAML parser would, then pull
    // out the actual key: value pairs.
    const fields: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      if (line.trim().startsWith("#") || line.trim() === "") continue;
      const m = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
      if (m) fields[m[1]] = m[2];
    }

    expect(fields.name).toBe("pdf-tools");
    expect(fields.description).toBeTruthy();
    expect(fields.description.length).toBeGreaterThan(0);
  });

  it("a freshly-scaffolded skill folder passes ahood publish's own SKILL.md check end-to-end", async () => {
    await init(["pdf-tools"]);
    const uploadCapture: { body?: Uint8Array } = {};
    stubPublishApi(uploadCapture);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await publish(["alice/pdf-tools@1.0.0", "--path", join(dir, "pdf-tools")]);

    expect(uploadCapture.body).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Published alice/pdf-tools@1.0.0"));
    logSpy.mockRestore();
  });
});
