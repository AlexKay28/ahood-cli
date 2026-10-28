// The built CLI, end to end, for the ahood#979 commands: dispatch, help, the
// exit codes main() maps API errors to, and sync's refusal with no terminal
// (stdin is a pipe here, exactly as under CI or an agent).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const cliPath = resolve(__dirname, "..", "dist", "index.js");

let server: Server;
let apiUrl: string;
let dir: string;
let installedFile: string;
let statusCode = 200;

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: dir,
        env: { ...process.env, HOME: dir, AHOOD_API_URL: apiUrl, AHOOD_TOKEN: "t", AHOOD_INSTALLED_FILE: installedFile },
        encoding: "utf8",
      },
      (error, stdout, stderr) => done({ stdout, stderr, code: error ? ((error as { code?: number }).code ?? 1) : 0 }),
    );
    child.stdin?.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ahood-cli-979-"));
  installedFile = join(dir, "installed.json");
  const skillPath = join(dir, ".claude", "skills", "alice@pdf-tools");
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(
    installedFile,
    JSON.stringify({
      version: 1,
      items: [{ owner: "alice", slug: "pdf-tools", version: "1.0.0", kind: "skill", installedPath: skillPath, projectDir: dir, installedAt: "t" }],
    }),
  );
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/me/status" && statusCode === 200) {
      res.end(JSON.stringify({
        items: [{ owner: "alice", slug: "pdf-tools", installed_version: "1.0.0", status: "ok", kind: "skill", latest_version: "1.1.0", update_available: true, is_owner: false }],
        plan: { evolution_available: false, consented: false },
      }));
      return;
    }
    res.statusCode = statusCode === 200 ? 404 : statusCode;
    res.end(JSON.stringify({ error: statusCode === 403 ? "This token's scopes do not include 'read'" : "Not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("built CLI: ahood#979 commands", () => {
  it("status prints the update", async () => {
    statusCode = 200;
    const { stdout, code } = await run(["status"]);
    expect(code).toBe(0);
    expect(stdout).toContain("update available");
  });

  it("sync with piped stdin and no --yes refuses with exit 2 and changes nothing", async () => {
    statusCode = 200;
    const { stderr, code } = await run(["sync"]);
    expect(code).toBe(2);
    expect(stderr).toContain("will not update without consent");
    expect(stderr).toContain("Re-run with --yes");
  });

  it("a scope-less token gets the scope hint (exit 4)", async () => {
    statusCode = 403;
    const { stderr, code } = await run(["status"]);
    expect(code).toBe(4);
    expect(stderr).toContain("missing a scope");
    expect(stderr).toContain("ahood login");
  });

  it("401 tells the user to log in (exit 4)", async () => {
    statusCode = 401;
    const { stderr, code } = await run(["review"]);
    expect(code).toBe(4);
    expect(stderr).toContain("Run `ahood login` first");
  });

  it("404 on a decision is exit 5", async () => {
    statusCode = 200;
    const { code } = await run(["review", "reject", "nope"]);
    expect(code).toBe(5);
  });

  it("each command has --help", async () => {
    for (const [cmd, usage] of [["status", "ahood status"], ["sync", "ahood sync"], ["pin", "ahood pin"], ["unpin", "ahood unpin"], ["review", "ahood review"]]) {
      const { stdout, code } = await run([cmd, "--help"]);
      expect(code).toBe(0);
      expect(stdout.startsWith(usage)).toBe(true);
    }
  });
});
