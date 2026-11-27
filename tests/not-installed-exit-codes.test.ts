import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ahood-cli#255: the exit code is what a script branches on, and for
// update/remove it is set two different ways (a thrown error mapped by
// index.ts, and process.exitCode from inside a batch loop) -- so these run
// the built dist/index.js as a real child process and read its status,
// rather than asserting on either mechanism separately.
const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "dist", "index.js");

describe("exit codes for 'not installed' and local validation (ahood-cli#255)", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "ahood-255-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "ahood-255-cwd-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // No credentials and an RFC 2606 `.invalid` registry: every case below must
  // be decided locally, so a request would surface as exit 6 instead.
  function run(args: string[]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      AHOOD_API_URL: "http://registry.invalid",
      AHOOD_INSTALLED_FILE: path.join(home, "installed.json"),
    };
    delete env.AHOOD_TOKEN;
    delete env.AHOOD_API_TOKEN;
    const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, env, input: "", timeout: 15_000 });
    return { status: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  it.each([
    ["skill update alice/foo", 5, /alice\/foo is not installed/],
    ["skill remove alice/foo --yes", 5, /alice\/foo was not installed/],
    ["pin alice/foo", 5, /alice\/foo is not installed/],
    ["unpin alice/foo", 5, /alice\/foo is not installed/],
    ["skill update --bogus", 2, /--bogus/],
    ["skill outdated --yes", 2, /--yes/],
  ])("`ahood %s` exits %i", (command, status, stderr) => {
    const result = run(command.split(" "));
    expect(result.stderr).toMatch(stderr);
    expect(result.status).toBe(status);
  });

  it("`ahood skill publish` on a folder with no root doc exits 2", () => {
    const folder = path.join(cwd, "empty");
    mkdirSync(folder);
    const result = run(["skill", "publish", "alice/foo@1.0.0", "--path", folder]);
    expect(result.stderr).toMatch(/No SKILL\.md.* found at /);
    expect(result.status).toBe(2);
  });

  it("a no-args `ahood skill update` still exits 0 past a lockfile entry that vanished", () => {
    mkdirSync(path.join(cwd, ".claude"));
    writeFileSync(path.join(cwd, ".claude", "skills.lock.json"), JSON.stringify({ "alice/vanished": null }));
    const result = run(["skill", "update"]);
    expect(result.stderr).toContain("Skipping alice/vanished: not currently installed.");
    expect(result.status).toBe(0);
  });
});
