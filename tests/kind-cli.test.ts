import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Built-CLI tests for ahood-cli#172: what is verified here is observable
// process behavior -- what reaches stdout, whether a long-lived server starts,
// exit codes, and what ships in the npm tarball -- so it runs dist/index.js
// (or the packed tarball's copy of it) as a real child process.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const cliPath = path.join(root, "dist", "index.js");
const skillSource = path.join(root, "src", "useme", "SKILL.md");

// An environment with no credentials and no reachable registry: HOME points at
// an empty directory (no stored login), AHOOD_TOKEN is unset, and the API URL
// is an RFC 2606 `.invalid` host that can never resolve.
function offlineEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  delete env.AHOOD_TOKEN;
  env.AHOOD_API_URL = "http://registry.invalid";
  return env;
}

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; cli?: string } = {}) {
  const result = spawnSync(process.execPath, [opts.cli ?? cliPath, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    // stdin closed: if anything here wrongly started the stdio MCP server, it
    // would see EOF and exit 0 with no usage text -- so asserting exit 2 plus
    // usage text below really does prove no server started. The timeout is a
    // backstop so a regression fails instead of hanging the suite.
    input: "",
    timeout: 15_000,
  });
  return { stdout: result.stdout, stderr: result.stderr.toString(), status: result.status, signal: result.signal };
}

// Speaks just enough MCP over stdio to prove a real server is answering: send
// `initialize`, read the FIRST stdout line, and require it to be that
// request's JSON-RPC response -- any banner or log line printed before the
// protocol would be the first line instead, and fail the parse.
function firstStdoutLine(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no response from \`ahood ${args.join(" ")}\` within 15s`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        child.kill();
        resolvePromise(buffer.slice(0, newline));
      }
    });
    child.on("error", reject);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }) + "\n",
    );
  });
}

describe("ahood mcp: the local stdio server is unchanged", () => {
  for (const args of [["mcp"], ["mcp", "serve"]]) {
    it(`\`ahood ${args.join(" ")}\` serves MCP over stdio, offline and unauthenticated, with nothing before the protocol`, async () => {
      const home = mkdtempSync(path.join(tmpdir(), "ahood-mcp-serve-"));
      try {
        const line = await firstStdoutLine(args, offlineEnv(home));
        const message = JSON.parse(line);
        expect(message).toMatchObject({ jsonrpc: "2.0", id: 1 });
        expect(message.result.serverInfo.name).toBe("ahood");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  for (const args of [["mcp", "srve"], ["mcp", "--stdio"], ["mcp", "serve", "extra"]]) {
    it(`\`ahood ${args.join(" ")}\` fails with usage (exit 2) instead of starting a server`, () => {
      const { stdout, stderr, status, signal } = run(args);
      expect(signal).toBeNull();
      expect(status).toBe(2);
      expect(stdout.toString()).toBe("");
      expect(stderr).toMatch(/Unknown mcp command|takes no arguments/);
      expect(stderr).toMatch(/ahood mcp serve/);
    });
  }

  it("suggests `serve` for a near-miss", () => {
    expect(run(["mcp", "srve"]).stderr).toContain("Did you mean 'serve'?");
  });

  for (const args of [["mcp", "--help"], ["mcp", "-h"], ["help", "mcp"]]) {
    it(`\`ahood ${args.join(" ")}\` prints help describing both meanings, without starting a server`, () => {
      const { stdout, status } = run(args);
      expect(status).toBe(0);
      const text = stdout.toString();
      expect(text).toContain("ahood mcp serve");
      expect(text).toContain("read-only MCP server over stdio");
      expect(text).toContain("ahood mcp add <owner>/<server>");
      expect(text).toContain("https://ahood.vercel.app/api/mcp");
    });
  }

  it("`ahood mcp serve --help` and `ahood mcp add --help` print per-verb help", () => {
    expect(run(["mcp", "serve", "--help"]).stdout.toString()).toMatch(/^ahood mcp serve\n/);
    expect(run(["mcp", "add", "--help"]).stdout.toString()).toMatch(/^ahood mcp add <owner>\/<server>/);
  });
});

describe("agent/mcp command groups are discoverable", () => {
  it("`ahood --help` lists the agent and mcp groups and the use-me guide", () => {
    const text = run(["--help"]).stdout.toString();
    expect(text).toContain("Use ahood with an AI agent:");
    expect(text).toContain("ahood help useme");
    expect(text).toContain("ahood agent <command>");
    expect(text).toContain("ahood mcp <command>");
  });

  it("`ahood agent` prints agent help; `ahood agent bogus` fails with a suggestion", () => {
    expect(run(["agent"]).stdout.toString()).toContain("ahood agent -- manage agent definitions");
    const bad = run(["agent", "serch", "x"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Unknown agent command: serch");
    expect(bad.stderr).toContain("Did you mean 'search'?");
  });

  it("`ahood skill --help` labels the group legacy and cross-kind, with the --kind escape hatch", () => {
    const text = run(["skill", "--help"]).stdout.toString();
    expect(text).toContain("ahood skill -- manage skills in the ahood registry");
    expect(text).toContain("Legacy, cross-kind");
    expect(text).toContain("--kind all");
  });

  it("completion offers agent/mcp verbs, `serve`, and `help useme`", () => {
    const bash = run(["completion", "bash"]).stdout.toString();
    expect(bash).toMatch(/local agent_words="[^"]*\bpublish\b/);
    expect(bash).toMatch(/local mcp_words="[^"]*\bserve\b[^"]*\binit\b/);
    expect(bash).toMatch(/local help_words="useme /);
    expect(bash).toMatch(/local top_words="[^"]*\bagent\b[^"]*\bmcp\b/);
  });

  it("a contradictory --kind on a kind group is a usage error before any request", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ahood-kind-flag-"));
    try {
      const { status, stderr } = run(["agent", "list", "--kind", "mcp"], { env: offlineEnv(home) });
      expect(status).toBe(2);
      expect(stderr).toContain("--kind mcp contradicts it");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ahood help useme", () => {
  it("prints the bundled SKILL.md byte-for-byte, offline, unauthenticated, writing nothing", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ahood-useme-home-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "ahood-useme-cwd-"));
    try {
      const { stdout, stderr, status } = run(["help", "useme"], { cwd, env: offlineEnv(home) });
      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(Buffer.compare(stdout, readFileSync(skillSource))).toBe(0);
      expect(readdirSync(cwd)).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("is a valid, trigger-friendly SKILL.md with no terminal escapes", () => {
    const content = readFileSync(skillSource, "utf8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(frontmatter).not.toBeNull();
    const lines = frontmatter![1].split("\n");
    expect(lines).toContain("name: ahood");
    const description = lines.find((l) => l.startsWith("description: "))!.slice("description: ".length);
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
    expect(lines).toHaveLength(2); // name + one-line description, nothing a strict parser could trip on
    expect(content).not.toMatch(/\x1b/);
  });

  it("documents each kind group, mcp serve vs. manifests vs. hosted MCP, and does not repeat the old nested install path", () => {
    const content = readFileSync(skillSource, "utf8");
    for (const needle of ["ahood agent", "ahood mcp serve", "server.json", "AGENT.md", "AHOOD_TOKEN", "--json", "https://ahood.vercel.app/api/mcp", "unpublish"]) {
      expect(content).toContain(needle);
    }
    expect(content).toContain(".claude/skills/<owner>@<skill>/");
    expect(content).not.toMatch(/\.claude\/skills\/\{owner\}\/\{skill\}/);
  });
});

describe("npm tarball", () => {
  it("ships the self-skill, and the installed CLI prints it identically and version-matched", () => {
    const work = mkdtempSync(path.join(tmpdir(), "ahood-pack-"));
    try {
      const packJson = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], {
        cwd: root,
        encoding: "utf8",
      });
      const [packed] = JSON.parse(packJson) as Array<{ filename: string; version: string; files: Array<{ path: string }> }>;
      const files = packed.files.map((f) => f.path);
      expect(files).toContain("dist/useme/SKILL.md");
      expect(files).toContain("dist/index.js");

      execFileSync("tar", ["-xzf", path.join(work, packed.filename), "-C", work]);
      const pkgDir = path.join(work, "package");
      // Dependencies come from this checkout rather than the network; the CLI
      // code and the SKILL.md it prints come from the tarball alone.
      symlinkSync(path.join(root, "node_modules"), path.join(pkgDir, "node_modules"), "dir");
      const installedCli = path.join(pkgDir, "dist", "index.js");

      const home = path.join(work, "home");
      const cwd = path.join(work, "cwd");
      execFileSync("mkdir", ["-p", home, cwd]);
      const { stdout, stderr, status } = run(["help", "useme"], { cli: installedCli, cwd, env: offlineEnv(home) });
      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(Buffer.compare(stdout, readFileSync(path.join(pkgDir, "dist", "useme", "SKILL.md")))).toBe(0);
      expect(Buffer.compare(stdout, readFileSync(skillSource))).toBe(0);
      expect(run(["--version"], { cli: installedCli }).stdout.toString().trim()).toBe(`@ahood/cli ${packed.version}`);
      expect(existsSync(path.join(cwd, ".claude"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
