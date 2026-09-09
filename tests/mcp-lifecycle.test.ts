import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { add } from "../src/commands/add.js";
import { update } from "../src/commands/update.js";
import { remove } from "../src/commands/remove.js";
import { readLockfile } from "../src/lockfile.js";
import { MCP_CONFIG_PATH } from "../src/spec.js";
import { hashMcpServerConfig } from "../src/commands/add.js";

vi.mock("../src/secret-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/secret-prompt.js")>();
  return { ...actual, promptSecret: vi.fn(async () => "sk-live-lifecycle-secret") };
});
import { promptSecret } from "../src/secret-prompt.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "weather";

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

// End-to-end coverage across the three real command functions -- no single
// task's own test file exercises the fingerprint mechanism as it actually
// gets used: written by add, verified and re-stamped by update, verified
// and consumed by remove. Uses the secret-bearing npm+env shape throughout,
// since that's the shape every other new test in this plan skips in favor
// of the simpler 1-key remotes shape, and it's the one where key-order
// stability (and never leaking the secret into output) matters most.
describe("mcp lifecycle: add -> update -> remove", () => {
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalSecretEnv = process.env.WEATHER_API_KEY;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-mcp-lifecycle-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    delete process.env.WEATHER_API_KEY;
    process.exitCode = 0;
    vi.mocked(promptSecret).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalSecretEnv === undefined) delete process.env.WEATHER_API_KEY;
    else process.env.WEATHER_API_KEY = originalSecretEnv;
  });

  it("carries the fingerprint correctly through install, an in-place update, and removal, without the secret ever touching console output", async () => {
    const manifestV1 = {
      name: "weather",
      description: "x",
      packages: [
        {
          registry_type: "npm",
          identifier: "@example/weather-mcp",
          version: "1.0.0",
          runtime_hint: "npx",
          environment_variables: [{ name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true }],
        },
      ],
    };
    const archiveV1 = await tarGz({ "server.json": JSON.stringify(manifestV1) });
    const checksumV1 = sha256(archiveV1);

    // Collects every console line across the whole lifecycle to check the
    // secret never appears in it -- not asserting on *which* lines get
    // printed (e.g. AHOOD_API_URL's own benign "non-default endpoint"
    // console.error notice), just that none of them ever contain it.
    const consoleOutput: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => void consoleOutput.push(String(msg)));
    vi.spyOn(console, "warn").mockImplementation((msg) => void consoleOutput.push(String(msg)));
    vi.spyOn(console, "error").mockImplementation((msg) => void consoleOutput.push(String(msg)));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: "1.0.0", manifest: [{ path: "server.json" }], checksum_sha256: checksumV1 },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=1.0.0`) {
          return new Response(new Uint8Array(archiveV1), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    // --- install ---
    await add([`${OWNER}/${SKILL}`]);

    expect(promptSecret).toHaveBeenCalledTimes(1);
    let mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL]).toEqual({
      command: "npx",
      args: ["-y", "@example/weather-mcp@1.0.0"],
      env: { WEATHER_API_KEY: "sk-live-lifecycle-secret" },
    });
    let lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    const hashAfterInstall = lockfile[`${OWNER}/${SKILL}`].mcp_config_hash;
    expect(hashAfterInstall).toBe(hashMcpServerConfig(mcpConfig.mcpServers[SKILL]));

    // --- update to a newer version, re-resolving the same secret var ---
    const manifestV2 = { ...manifestV1, packages: [{ ...manifestV1.packages[0], version: "2.0.0" }] };
    const archiveV2 = await tarGz({ "server.json": JSON.stringify(manifestV2) });
    const checksumV2 = sha256(archiveV2);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: checksumV2 },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=2.0.0`) {
          return new Response(new Uint8Array(archiveV2), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await update([]);

    // Still 1 (from the install), not 2: the update carries the already-
    // verified secret forward instead of re-prompting. `ahood skill update`
    // with no args walks every locked entry, so prompting here broke
    // unattended use outright -- and with stdin a pipe carrying unrelated
    // data it banked the first line as the credential. The env assertion
    // just below is what proves the secret still made it through.
    expect(promptSecret).toHaveBeenCalledTimes(1);
    mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL]).toEqual({
      command: "npx",
      args: ["-y", "@example/weather-mcp@2.0.0"],
      env: { WEATHER_API_KEY: "sk-live-lifecycle-secret" },
    });
    lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    const hashAfterUpdate = lockfile[`${OWNER}/${SKILL}`].mcp_config_hash;
    expect(hashAfterUpdate).not.toBe(hashAfterInstall); // the entry's content changed (1.0.0 -> 2.0.0 in args)
    expect(hashAfterUpdate).toBe(hashMcpServerConfig(mcpConfig.mcpServers[SKILL]));
    expect(lockfile[`${OWNER}/${SKILL}`].version).toBe("2.0.0");

    // --- remove: real deletion, since the fingerprint update just wrote matches what's on disk ---
    await remove([`${OWNER}/${SKILL}`, "--yes"]);

    mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL]).toBeUndefined();
    lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    expect(lockfile[`${OWNER}/${SKILL}`]).toBeUndefined();

    // The secret must never appear in any console output across the whole lifecycle.
    expect(consoleOutput.join("\n")).not.toContain("sk-live-lifecycle-secret");
  });

  // Shared setup for the update-path regression tests below: installs v1
  // (one secret env var, supplied by the mocked prompt) and leaves the
  // fetch stub serving whatever v2 manifest the caller passes.
  async function installV1ThenServeV2(v2EnvVars: unknown[]): Promise<string[]> {
    const basePkg = { registry_type: "npm", identifier: "@example/weather-mcp", runtime_hint: "npx" };
    const manifestV1 = {
      name: "weather",
      description: "x",
      packages: [
        {
          ...basePkg,
          version: "1.0.0",
          environment_variables: [{ name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true }],
        },
      ],
    };
    const manifestV2 = { ...manifestV1, packages: [{ ...basePkg, version: "2.0.0", environment_variables: v2EnvVars }] };
    const archiveV1 = await tarGz({ "server.json": JSON.stringify(manifestV1) });
    const archiveV2 = await tarGz({ "server.json": JSON.stringify(manifestV2) });

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => void output.push(String(msg)));
    vi.spyOn(console, "warn").mockImplementation((msg) => void output.push(String(msg)));
    vi.spyOn(console, "error").mockImplementation((msg) => void output.push(String(msg)));

    let serving: { version: string; archive: Buffer; checksum: string } = {
      version: "1.0.0",
      archive: archiveV1,
      checksum: sha256(archiveV1),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: serving.version, manifest: [{ path: "server.json" }], checksum_sha256: serving.checksum },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download?version=${serving.version}`) {
          return new Response(new Uint8Array(serving.archive), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await add([`${OWNER}/${SKILL}`]);
    expect(promptSecret).toHaveBeenCalledTimes(1);
    serving = { version: "2.0.0", archive: archiveV2, checksum: sha256(archiveV2) };
    return output;
  }

  // ahood-cli#169 review: a bare `ahood skill update` walks EVERY locked
  // entry, so a prompt on that path is never something the caller aimed at.
  // A secret that's genuinely new in the incoming version has nothing to
  // carry forward, so it has to fail loudly rather than hang on an idle pipe
  // or bank the first line of unrelated piped input as the credential.
  // process.stdin.isTTY is already falsy under vitest, i.e. this is exactly
  // the unattended shape.
  it("fails an unattended update with an actionable error instead of prompting for a newly-introduced secret", async () => {
    const output = await installV1ThenServeV2([
      { name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true },
      { name: "WEATHER_ORG_TOKEN", description: "Org token", is_required: true, is_secret: true },
    ]);

    await update([]);

    expect(promptSecret).toHaveBeenCalledTimes(1); // still just the install's
    expect(output.join("\n")).toContain("WEATHER_ORG_TOKEN");
    expect(output.join("\n")).toMatch(/no terminal to prompt on/);
    expect(process.exitCode).toBe(1);

    // ...and the failed update rolled .mcp.json back to the v1 entry rather
    // than leaving it half-written.
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL].args).toEqual(["-y", "@example/weather-mcp@1.0.0"]);
  });

  // The env var stays ahead of the carried-forward value, so exporting it is
  // still the way to rotate a credential during an update.
  it("prefers an exported env var over the secret already on disk", async () => {
    await installV1ThenServeV2([
      { name: "WEATHER_API_KEY", description: "API key", is_required: true, is_secret: true },
    ]);
    process.env.WEATHER_API_KEY = "sk-live-rotated";

    await update([]);

    expect(promptSecret).toHaveBeenCalledTimes(1); // still just the install's
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers[SKILL].env).toEqual({ WEATHER_API_KEY: "sk-live-rotated" });
  });
});
