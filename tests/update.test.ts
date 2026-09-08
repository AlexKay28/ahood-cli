import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { update } from "../src/commands/update.js";
import { writeLockfileEntry, readLockfile } from "../src/lockfile.js";
import { skillDir, MCP_CONFIG_PATH } from "../src/spec.js";
import { hashMcpServerConfig } from "../src/commands/add.js";

const API_URL = "http://ahood.test";

function tarGz(files: Record<string, string>): Promise<Buffer> {
  const tar = pack();
  for (const [name, content] of Object.entries(files)) tar.entry({ name }, content);
  tar.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolvePromise, reject) => {
    tar.on("data", (chunk) => chunks.push(chunk as Buffer));
    tar.on("end", () => resolvePromise(gzipSync(Buffer.concat(chunks))));
    tar.on("error", reject);
  });
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("update", () => {
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-update-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    // A previous test asserting exitCode === 1 can leave it set if it fails
    // before reaching its own reset -- start every test from a known state
    // rather than relying on run order.
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Without this, console.log/console.error spies from an earlier test in
    // this file are never un-wrapped -- vi.spyOn() on an already-spied method
    // just stacks another layer, so a later test's mock.calls silently
    // includes output from tests that ran before it.
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("reports nothing to do when the lockfile is empty", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await update([]);
    expect(logSpy).toHaveBeenCalledWith("No installed skills to update.");
  });

  it("continues updating remaining skills after one fails, and exits non-zero", async () => {
    const goodArchive = await tarGz({ "SKILL.md": "# good\n" });
    const goodChecksum = sha256(goodArchive);

    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/good", {
      version: "1.0.0",
      checksum_sha256: "old",
    });
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "bob/broken", {
      version: "1.0.0",
      checksum_sha256: "old",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/good`) {
          return new Response(
            JSON.stringify({ skill_versions: { version: "1.1.0", manifest: [{ path: "SKILL.md" }], checksum_sha256: goodChecksum } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/good/download?version=1.1.0`) {
          return new Response(new Uint8Array(goodArchive), { status: 200 });
        }
        if (url === `${API_URL}/api/v1/skills/bob/broken`) {
          return new Response(JSON.stringify({ error: "This skill was unpublished" }), { status: 404 });
        }
        return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
      }),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await update([]);

    expect(readFileSync(join(dir, skillDir("alice", "good"), "SKILL.md"), "utf-8")).toBe("# good\n");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bob/broken"));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("skips an explicitly-named skill that isn't installed, without calling add() or writing anything", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lockfilePath = join(dir, ".claude", "skills.lock.json");

    await update(["alice/never-installed"]);

    expect(warnSpy).toHaveBeenCalledWith("Skipping alice/never-installed: not currently installed.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dir, skillDir("alice", "never-installed")))).toBe(false);
    // No lockfile was ever written -- `update` on a target that was never
    // installed must not create one, let alone pin an entry into it.
    expect(existsSync(lockfilePath)).toBe(false);
    expect(process.exitCode).not.toBe(1);
    process.exitCode = 0;
  });

  it("updates only the explicitly-named skills that are installed, and skips the rest with a warning", async () => {
    const goodArchive = await tarGz({ "SKILL.md": "# good\n" });
    const goodChecksum = sha256(goodArchive);

    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/good", {
      version: "1.0.0",
      checksum_sha256: "old",
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/alice/good`) {
        return new Response(
          JSON.stringify({ skill_versions: { version: "1.1.0", manifest: [{ path: "SKILL.md" }], checksum_sha256: goodChecksum } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${API_URL}/api/v1/skills/alice/good/download?version=1.1.0`) {
        return new Response(new Uint8Array(goodArchive), { status: 200 });
      }
      // bob/never-installed must never be resolved or fetched at all -- it
      // isn't in the lockfile, so it should be skipped before add() is called.
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await update(["alice/good", "bob/never-installed"]);

    expect(readFileSync(join(dir, skillDir("alice", "good"), "SKILL.md"), "utf-8")).toBe("# good\n");
    expect(warnSpy).toHaveBeenCalledWith("Skipping bob/never-installed: not currently installed.");
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("bob/never-installed"))).toBe(false);
    expect(process.exitCode).not.toBe(1);
    process.exitCode = 0;
  });

  it("no-args update of every currently-installed skill is unaffected by the not-installed guard", async () => {
    const goodArchive = await tarGz({ "SKILL.md": "# good\n" });
    const goodChecksum = sha256(goodArchive);
    const otherArchive = await tarGz({ "SKILL.md": "# other\n" });
    const otherChecksum = sha256(otherArchive);

    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/good", {
      version: "1.0.0",
      checksum_sha256: "old",
    });
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/other", {
      version: "1.0.0",
      checksum_sha256: "old",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/good`) {
          return new Response(
            JSON.stringify({ skill_versions: { version: "1.1.0", manifest: [{ path: "SKILL.md" }], checksum_sha256: goodChecksum } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/good/download?version=1.1.0`) {
          return new Response(new Uint8Array(goodArchive), { status: 200 });
        }
        if (url === `${API_URL}/api/v1/skills/alice/other`) {
          return new Response(
            JSON.stringify({ skill_versions: { version: "1.2.0", manifest: [{ path: "SKILL.md" }], checksum_sha256: otherChecksum } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/other/download?version=1.2.0`) {
          return new Response(new Uint8Array(otherArchive), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected request: ${url}` }), { status: 404 });
      }),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await update([]);

    // Every skill in the lockfile passes the "is it installed" check, so the
    // not-installed guard must never fire on the no-args path.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, skillDir("alice", "good"), "SKILL.md"), "utf-8")).toBe("# good\n");
    expect(readFileSync(join(dir, skillDir("alice", "other"), "SKILL.md"), "utf-8")).toBe("# other\n");
    expect(process.exitCode).not.toBe(1);
  });

  it("reports an already-up-to-date mcp artifact as a clean status, not a warning or failure (ahood-cli#169)", async () => {
    // Real mcp-update support (ahood-cli#169) means an mcp entry is no
    // longer unconditionally skipped -- but one already at "latest" still
    // has nothing to do, and (unlike skill/agent, which always blindly
    // re-extracts even when unchanged) is deliberately short-circuited
    // before hitting /download, so an up-to-date entry with a secret in its
    // env never re-triggers a masked prompt for no reason.
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/alice/weather`) {
        return new Response(
          JSON.stringify({
            skill_versions: { version: "1.0.0", manifest: [{ path: "server.json" }], checksum_sha256: "abc" },
            kind: "mcp",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // The download endpoint must never be hit for an already-up-to-date entry.
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await update([]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("alice/weather is already up to date"));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/download"))).toBe(false);
  });

  it("performs a real update when a newer version is available and the fingerprint matches (ahood-cli#169)", async () => {
    const oldEntry = { url: "https://mcp.example.com/v1/sse" };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: oldEntry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "old-checksum",
      mcp_config_hash: hashMcpServerConfig(oldEntry),
    });

    const manifest = { name: "weather", description: "x", remotes: [{ url: "https://mcp.example.com/v2/sse" }] };
    const archive = await tarGz({ "server.json": JSON.stringify(manifest) });
    const checksum = sha256(archive);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/weather`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: checksum },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/weather/download?version=2.0.0`) {
          return new Response(new Uint8Array(archive), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await update([]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual({ url: "https://mcp.example.com/v2/sse" });
    const lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    expect(lockfile["alice/weather"].version).toBe("2.0.0");
    expect(lockfile["alice/weather"].mcp_config_hash).toBe(hashMcpServerConfig({ url: "https://mcp.example.com/v2/sse" }));
    expect(process.exitCode).not.toBe(1);
  });

  it("refuses to update when the on-disk entry doesn't match the recorded fingerprint (hand-edited) (ahood-cli#169)", async () => {
    const installedEntry = { url: "https://mcp.example.com/v1/sse" };
    const handEditedEntry = { url: "https://mcp.example.com/v1/sse", headers: { "X-Custom": "added-by-hand" } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: handEditedEntry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "old-checksum",
      mcp_config_hash: hashMcpServerConfig(installedEntry),
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/alice/weather`) {
        return new Response(
          JSON.stringify({
            skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: "irrelevant" },
            kind: "mcp",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await update([]);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/modified since install/));
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/download"))).toBe(false);
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual(handEditedEntry);
    const lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    expect(lockfile["alice/weather"].version).toBe("1.0.0"); // pin NOT moved forward
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("self-heals by installing fresh when the .mcp.json entry is missing despite a lockfile pin (ahood-cli#169)", async () => {
    // No .mcp.json file at all -- e.g. deleted by hand without going through `ahood skill remove`.
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "old-checksum",
      mcp_config_hash: "some-stale-hash-that-cant-match-anything",
    });

    const manifest = { name: "weather", description: "x", remotes: [{ url: "https://mcp.example.com/v2/sse" }] };
    const archive = await tarGz({ "server.json": JSON.stringify(manifest) });
    const checksum = sha256(archive);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/weather`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: checksum },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/weather/download?version=2.0.0`) {
          return new Response(new Uint8Array(archive), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await update([]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual({ url: "https://mcp.example.com/v2/sse" });
    expect(process.exitCode).not.toBe(1);
  });

  describe("--dry-run", () => {
    const lockfilePath = () => join(dir, ".claude", "skills.lock.json");
    const skillDirPath = (owner: string, skill: string) => join(dir, skillDir(owner, skill));

    function stubResolveOnly(fetchCalls: string[]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          fetchCalls.push(url);
          if (url === `${API_URL}/api/v1/skills/alice/behind`) {
            return new Response(
              JSON.stringify({
                skill_versions: {
                  version: "2.0.0",
                  manifest: [{ path: "SKILL.md" }],
                  checksum_sha256: "new-checksum",
                  changelog_md: "## 2.0.0\n- Breaking change.",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url === `${API_URL}/api/v1/skills/alice/current`) {
            return new Response(
              JSON.stringify({
                skill_versions: {
                  version: "1.0.0",
                  manifest: [{ path: "SKILL.md" }],
                  checksum_sha256: "same-checksum",
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // Any download endpoint hit at all means --dry-run failed to stay
          // read-only -- fail loudly instead of serving a fake archive.
          throw new Error(`unexpected fetch during --dry-run: ${url}`);
        }),
      );
    }

    beforeEach(() => {
      writeLockfileEntry(lockfilePath(), "alice/behind", { version: "1.0.0", checksum_sha256: "old-checksum" });
      writeLockfileEntry(lockfilePath(), "alice/current", { version: "1.0.0", checksum_sha256: "same-checksum" });
    });

    it("previews the diff table without installing, downloading, or touching the lockfile", async () => {
      const fetchCalls: string[] = [];
      stubResolveOnly(fetchCalls);
      const lockfileBefore = readFileSync(lockfilePath(), "utf-8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await update(["--dry-run"]);

      // No download endpoint was ever hit.
      expect(fetchCalls.some((u) => u.includes("/download"))).toBe(false);
      // Nothing was extracted to disk.
      expect(existsSync(skillDirPath("alice", "behind"))).toBe(false);
      // The lockfile is byte-for-byte unchanged -- --dry-run never re-pins anything.
      expect(readFileSync(lockfilePath(), "utf-8")).toBe(lockfileBefore);

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("alice/behind");
      expect(output).toContain("1.0.0");
      expect(output).toContain("2.0.0");
      expect(output).toContain("update available");
      expect(output).toContain("Breaking change.");
    });

    it("marks a skill already at latest as up to date, not as needing an update", async () => {
      const fetchCalls: string[] = [];
      stubResolveOnly(fetchCalls);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await update(["alice/current", "--dry-run"]);

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("up to date");
      expect(output).not.toContain("update available");
      expect(output).toContain("All skills are already up to date.");
    });

    it("emits structured, machine-readable output with --json", async () => {
      const fetchCalls: string[] = [];
      stubResolveOnly(fetchCalls);

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await update(["--dry-run", "--json"]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
      expect(parsed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            skill: "alice/behind",
            current_version: "1.0.0",
            latest_version: "2.0.0",
            up_to_date: false,
            changelog_md: "## 2.0.0\n- Breaking change.",
          }),
          expect.objectContaining({
            skill: "alice/current",
            current_version: "1.0.0",
            latest_version: "1.0.0",
            up_to_date: true,
            changelog_md: null,
          }),
        ]),
      );
      expect(fetchCalls.some((u) => u.includes("/download"))).toBe(false);
      expect(existsSync(skillDirPath("alice", "behind"))).toBe(false);
    });
  });
});
