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
});
