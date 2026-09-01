import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extract as tarExtract } from "tar-stream";
import { publish } from "../src/commands/publish.js";

const API_URL = "http://ahood.test";

async function listArchiveEntries(archiveBody: Uint8Array): Promise<string[]> {
  const decompressed = gunzipSync(Buffer.from(archiveBody));
  const names: string[] = [];
  const ex = tarExtract();
  await new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      names.push(header.name);
      stream.resume();
      stream.on("end", next);
    });
    ex.on("finish", resolve);
    ex.on("error", reject);
    ex.end(decompressed);
  });
  return names;
}

function stubApi(uploadCapture: { body?: Uint8Array }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/versions/init")) {
        return new Response(
          JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "http://upload.test/put") {
        uploadCapture.body = init.body as Uint8Array;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/versions/complete")) {
        return new Response(JSON.stringify({ version_id: "v1", version: "1.0.0", status: "processing" }), { status: 202 });
      }
      // GET .../skills/<owner>/<skill>/versions/<version> -- polled after
      // complete's 202. Publishes immediately in this stub so tests don't
      // wait through a real poll interval; a dedicated test below exercises
      // the actual multi-poll loop with fake timers.
      if (/\/versions\/[^/]+$/.test(url) && !url.endsWith("/versions/init") && !url.endsWith("/versions/complete")) {
        return new Response(JSON.stringify({ version: "1.0.0", status: "published" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
    }),
  );
}

// Simulates a first-ever publish: the first /versions/init call 404s (skill
// doesn't exist), then POST /api/v1/skills creates it, then the retried
// /versions/init call succeeds. `captures.createBody` records what was sent
// to the create endpoint so tests can assert the create payload.
function stubApiFirstPublish(
  captures: { uploadBody?: Uint8Array; createBody?: unknown },
  opts: { createdOwner?: string } = {},
) {
  let initCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/versions/init")) {
        initCalls++;
        if (initCalls === 1) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response(
          JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/skills")) {
        captures.createBody = init.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({ id: "s1", slug: "demo", owner: opts.createdOwner ?? "alice" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "http://upload.test/put") {
        captures.uploadBody = init.body as Uint8Array;
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

describe("publish", () => {
  let dir: string;
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-publish-test-"));
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects when no SKILL.md is found", async () => {
    await expect(publish([`alice/demo@1.0.0`, "--path", dir])).rejects.toThrow(/No SKILL.md found/);
  });

  it("rejects an invalid --version", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    await expect(publish([dir, "--owner", "alice", "--slug", "demo", "--version", "not-semver"])).rejects.toThrow(
      /must be a semver/,
    );
  });

  it("publishes via the primary <owner>/<skill>@<version> form", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const capture: { body?: Uint8Array } = {};
    stubApi(capture);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await publish([`alice/demo@1.0.0`, "--path", dir]);

    expect(logSpy).toHaveBeenCalledWith("Published alice/demo@1.0.0 (published)");
  });

  it("still supports the legacy <path> --owner --slug --version form", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const capture: { body?: Uint8Array } = {};
    stubApi(capture);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await publish([dir, "--owner", "alice", "--slug", "demo", "--version", "1.0.0"]);

    expect(logSpy).toHaveBeenCalledWith("Published alice/demo@1.0.0 (published)");
  });

  it("errors instead of treating a flag as the legacy path when the path is omitted", async () => {
    await expect(
      publish(["--owner", "alice", "--slug", "demo", "--version", "1.0.0"]),
    ).rejects.toThrow(/No SKILL.md found/);
  });

  it("errors instead of swallowing the next flag as this one's value", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    await expect(
      publish([dir, "--owner", "--slug", "demo", "--version", "1.0.0"]),
    ).rejects.toThrow(/--owner requires a value/);
  });

  it("excludes .git, node_modules, .env, and credential files by name", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), "secret remote");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "noise");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=abc");
    writeFileSync(join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");

    const capture: { body?: Uint8Array } = {};
    stubApi(capture);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await publish([`alice/demo@1.0.0`, "--path", dir]);

    const entries = await listArchiveEntries(capture.body!);
    expect(entries).toEqual(["SKILL.md"]);
  });

  it("skips symlinks instead of packing their target's contents", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const secretDir = mkdtempSync(join(tmpdir(), "ahood-publish-secret-"));
    writeFileSync(join(secretDir, "outside-secret.txt"), "TOP SECRET");
    symlinkSync(join(secretDir, "outside-secret.txt"), join(dir, "link.txt"));

    try {
      const capture: { body?: Uint8Array } = {};
      stubApi(capture);
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await publish([`alice/demo@1.0.0`, "--path", dir]);

      const entries = await listArchiveEntries(capture.body!);
      expect(entries).toEqual(["SKILL.md"]);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it("creates the skill via POST /api/v1/skills when versions/init 404s on first publish, then retries and succeeds", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const captures: { uploadBody?: Uint8Array; createBody?: unknown } = {};
    stubApiFirstPublish(captures);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await publish([
      "alice/demo@1.0.0",
      "--path", dir,
      "--name", "Demo Skill",
      "--tagline", "A demo",
      "--tags", "web, cli",
      "--license", "MIT",
    ]);

    expect(captures.createBody).toEqual({
      slug: "demo",
      name: "Demo Skill",
      tagline: "A demo",
      tags: ["web", "cli"],
      license: "MIT",
    });
    expect(logSpy).toHaveBeenCalledWith("Published alice/demo@1.0.0 (published)");
  });

  it("forwards --homepage and --repository to the create-skill body on first publish", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const captures: { uploadBody?: Uint8Array; createBody?: unknown } = {};
    stubApiFirstPublish(captures);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await publish([
      "alice/demo@1.0.0",
      "--path", dir,
      "--name", "Demo Skill",
      "--homepage", "https://example.com",
      "--repository", "https://github.com/alice/demo",
    ]);

    expect(captures.createBody).toEqual({
      slug: "demo",
      name: "Demo Skill",
      homepage: "https://example.com",
      repository: "https://github.com/alice/demo",
    });
    expect(logSpy).toHaveBeenCalledWith("Published alice/demo@1.0.0 (published)");
  });

  // ahood-cli#34: a javascript:/data: --homepage or --repository must be
  // rejected client-side, before any network call -- these only ever reach
  // the server via the create-skill body, which stores them verbatim and
  // the web frontend renders as a raw <a href>.
  it("rejects a javascript: --homepage before making any request", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publish([
        "alice/demo@1.0.0",
        "--path", dir,
        "--name", "Demo Skill",
        "--homepage", "javascript:alert(1)",
      ]),
    ).rejects.toThrow(/--homepage must use http:\/\/ or https:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a data: --repository before making any request", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      publish([
        "alice/demo@1.0.0",
        "--path", dir,
        "--name", "Demo Skill",
        "--repository", "data:text/html,<script>alert(1)</script>",
      ]),
    ).rejects.toThrow(/--repository must use http:\/\/ or https:\/\//);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not attempt to create the skill when versions/init succeeds on the first try (existing-skill regression check)", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const capture: { body?: Uint8Array } = {};
    stubApi(capture);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await publish(["alice/demo@1.0.0", "--path", dir, "--name", "Demo Skill"]);

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([u]) => String(u).endsWith("/api/v1/skills"))).toBe(false);
  });

  it("errors clearly when --name is missing and the skill doesn't exist yet, without attempting the upload", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const uploadCalled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/versions/init")) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        if (url === "http://upload.test/put") {
          uploadCalled();
          return new Response(null, { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await expect(publish(["alice/demo@1.0.0", "--path", dir])).rejects.toThrow(
      /doesn't exist yet -- pass --name/,
    );
    expect(uploadCalled).not.toHaveBeenCalled();
  });

  it("errors clearly when the created skill lands under a different owner than requested", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    const captures: { uploadBody?: Uint8Array; createBody?: unknown } = {};
    stubApiFirstPublish(captures, { createdOwner: "realuser" });

    await expect(
      publish(["alice/demo@1.0.0", "--path", dir, "--name", "Demo Skill"]),
    ).rejects.toThrow(/skills are always created under your own account \(realuser\)/);
  });

  it("polls the version's status after complete's 202 until it leaves 'processing'", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    let pollCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/versions/init")) {
          return new Response(
            JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }),
            { status: 200 },
          );
        }
        if (url === "http://upload.test/put") return new Response(null, { status: 200 });
        if (url.endsWith("/versions/complete")) {
          return new Response(JSON.stringify({ version_id: "v1", version: "1.0.0", status: "processing" }), { status: 202 });
        }
        if (/\/versions\/[^/]+$/.test(url) && !url.endsWith("/versions/init") && !url.endsWith("/versions/complete")) {
          pollCalls++;
          if (pollCalls < 3) {
            return new Response(JSON.stringify({ version: "1.0.0", status: "processing" }), { status: 200 });
          }
          return new Response(JSON.stringify({ version: "1.0.0", status: "published" }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const publishPromise = publish([`alice/demo@1.0.0`, "--path", dir]);
    await vi.runAllTimersAsync();
    await publishPromise;
    vi.useRealTimers();

    expect(pollCalls).toBe(3);
    expect(logSpy).toHaveBeenCalledWith("Published alice/demo@1.0.0 (published)");
  });

  it("throws a clear error including the failure reason when the version ends up 'failed'", async () => {
    writeFileSync(join(dir, "SKILL.md"), "# demo");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/versions/init")) {
          return new Response(
            JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }),
            { status: 200 },
          );
        }
        if (url === "http://upload.test/put") return new Response(null, { status: 200 });
        if (url.endsWith("/versions/complete")) {
          return new Response(JSON.stringify({ version_id: "v1", version: "1.0.0", status: "processing" }), { status: 202 });
        }
        if (/\/versions\/[^/]+$/.test(url) && !url.endsWith("/versions/init") && !url.endsWith("/versions/complete")) {
          return new Response(
            JSON.stringify({ version: "1.0.0", status: "failed", failure_reason: "Archive could not be extracted -- is it a valid .tar.gz file?" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await expect(publish([`alice/demo@1.0.0`, "--path", dir])).rejects.toThrow(
      /Publish failed: Archive could not be extracted/,
    );
  });

  // ahood-cli#57: --json must emit exactly one JSON object on stdout and
  // none of the human "Created/Uploaded/Published" progress lines, so a CI
  // caller can pipe stdout straight into `jq` without scraping text.
  describe("--json", () => {
    it("emits exactly one JSON object with {version, status} on success and no human progress lines", async () => {
      writeFileSync(join(dir, "SKILL.md"), "# demo");
      const capture: { body?: Uint8Array } = {};
      stubApi(capture);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      logSpy.mockClear(); // spyOn on an already-spied console.log reuses the same mock (no restore between tests in this file), so clear any calls accumulated by earlier tests.

      await publish([`alice/demo@1.0.0`, "--path", dir, "--json"]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const [line] = logSpy.mock.calls[0] as [string];
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line)).toEqual({ version: "1.0.0", status: "published" });
      // None of the human progress lines leaked onto stdout.
      const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allOutput).not.toMatch(/Uploaded|Published alice\/demo/);
    });

    it("includes the create-step result when a new skill was created during this call", async () => {
      writeFileSync(join(dir, "SKILL.md"), "# demo");
      const captures: { uploadBody?: Uint8Array; createBody?: unknown } = {};
      stubApiFirstPublish(captures);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      logSpy.mockClear();

      await publish(["alice/demo@1.0.0", "--path", dir, "--name", "Demo Skill", "--json"]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const [line] = logSpy.mock.calls[0] as [string];
      const parsed = JSON.parse(line);
      expect(parsed).toEqual({
        version: "1.0.0",
        status: "published",
        created: { id: "s1", slug: "demo", owner: "alice" },
      });
    });

    it("emits a single {error} JSON object on stdout and preserves the exit-relevant error on a rejected publish", async () => {
      writeFileSync(join(dir, "SKILL.md"), "# demo");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/versions/init")) {
            return new Response(
              JSON.stringify({ upload_url: "http://upload.test/put", storage_path: "x", version_id: "v1" }),
              { status: 200 },
            );
          }
          if (url === "http://upload.test/put") return new Response(null, { status: 200 });
          if (url.endsWith("/versions/complete")) {
            return new Response(JSON.stringify({ version_id: "v1", version: "1.0.0", status: "processing" }), { status: 202 });
          }
          if (/\/versions\/[^/]+$/.test(url) && !url.endsWith("/versions/init") && !url.endsWith("/versions/complete")) {
            return new Response(
              JSON.stringify({ version: "1.0.0", status: "failed", failure_reason: "Archive could not be extracted -- is it a valid .tar.gz file?" }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
        }),
      );
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      logSpy.mockClear();

      await expect(publish([`alice/demo@1.0.0`, "--path", dir, "--json"])).rejects.toThrow(
        /Publish failed: Archive could not be extracted/,
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const [line] = logSpy.mock.calls[0] as [string];
      const parsed = JSON.parse(line);
      expect(parsed.error).toMatch(/Publish failed: Archive could not be extracted/);
    });

    it("emits a single {error} JSON object for a client-side validation failure (bad --version), before any network call", async () => {
      writeFileSync(join(dir, "SKILL.md"), "# demo");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      logSpy.mockClear();

      await expect(
        publish([dir, "--owner", "alice", "--slug", "demo", "--version", "not-semver", "--json"]),
      ).rejects.toThrow(/must be a semver/);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledTimes(1);
      const [line] = logSpy.mock.calls[0] as [string];
      const parsed = JSON.parse(line);
      expect(parsed.error).toMatch(/must be a semver/);
    });
  });
});
