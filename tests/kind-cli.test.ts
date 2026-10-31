import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Built-CLI tests for ahood-cli#172: what is verified here is observable
// process behavior -- what reaches stdout and stderr, exit codes, and what ships in the npm tarball -- so it runs dist/index.js
// (or the packed tarball's copy of it) as a real child process.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const cliPath = path.join(root, "dist", "index.js");

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
    // stdin closed and a timeout, so a regression that waits on input fails
    // instead of hanging the suite.
    input: "",
    timeout: 15_000,
  });
  return { stdout: result.stdout, stderr: result.stderr.toString(), status: result.status, signal: result.signal };
}

// ahood#1018 step 2: the removed legacy forms each print exactly one line on
// stderr and exit 2, for one release, and run nothing else.
const REMOVED_NOTICE = "removed in 0.16.0 -- ahood is a plugin now: npx @ahood/cli setup\n";

describe("removed legacy forms (ahood#1018): one line, exit 2, nothing else", () => {
  for (const args of [["mcp", "serve"], ["mcp"], ["mcp", "serve", "--help"], ["mcp", "serve", "extra"], ["help", "useme"]]) {
    it(`\`ahood ${args.join(" ")}\` prints the removal notice and exits 2, offline, writing nothing`, () => {
      const home = mkdtempSync(path.join(tmpdir(), "ahood-removed-home-"));
      const cwd = mkdtempSync(path.join(tmpdir(), "ahood-removed-cwd-"));
      try {
        const { stdout, stderr, status, signal } = run(args, { cwd, env: offlineEnv(home) });
        expect(signal).toBeNull();
        expect(status).toBe(2);
        expect(stdout.toString()).toBe("");
        expect(stderr).toBe(REMOVED_NOTICE);
        expect(readdirSync(cwd)).toEqual([]);
        expect(readdirSync(home)).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it("the mcp-kind registry verbs still work: an unknown one fails with usage, not the notice", () => {
    const { stderr, status } = run(["mcp", "srve"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown mcp command: srve");
    expect(stderr).not.toContain("serve");
  });

  for (const args of [["mcp", "--help"], ["mcp", "-h"], ["help", "mcp"]]) {
    it(`\`ahood ${args.join(" ")}\` prints manifest help with no local server in it`, () => {
      const { stdout, status } = run(args);
      expect(status).toBe(0);
      const text = stdout.toString();
      expect(text).toContain("ahood mcp add <owner>/<server>");
      expect(text).toContain("npx @ahood/cli setup");
      expect(text).not.toContain("mcp serve");
      expect(text).not.toContain("stdio");
    });
  }

  it("`ahood mcp add --help` prints per-verb help", () => {
    expect(run(["mcp", "add", "--help"]).stdout.toString()).toMatch(/^ahood mcp add <owner>\/<server>/);
  });
});

describe("agent/mcp command groups are discoverable", () => {
  it("`ahood --help` lists the agent and mcp groups and points agents at the plugin, not the removed forms", () => {
    const text = run(["--help"]).stdout.toString();
    expect(text).toContain("Use ahood with an AI agent:");
    expect(text).toContain("npx @ahood/cli setup");
    expect(text).toContain("ahood agent <command>");
    expect(text).toContain("ahood mcp <command>");
    expect(text).not.toContain("useme");
    expect(text).not.toContain("mcp serve");
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

  it("completion offers agent/mcp verbs, but not `serve` or `help useme`", () => {
    const bash = run(["completion", "bash"]).stdout.toString();
    expect(bash).toMatch(/local agent_words="[^"]*\bpublish\b/);
    expect(bash).toMatch(/local mcp_words="[^"]*\binit\b/);
    expect(bash).not.toMatch(/\bserve\b/);
    expect(bash).not.toContain("useme");
    expect(bash).toMatch(/local help_words="skill /);
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

describe("ahood doc command group (ahood-cli#182)", () => {
  it("`ahood --help` lists `ahood doc <command>`; `ahood doc`, `--help` and `help doc` print doc help", () => {
    expect(run(["--help"]).stdout.toString()).toContain("ahood doc <command>");
    for (const args of [["doc"], ["doc", "--help"], ["help", "doc"]]) {
      const { stdout, status } = run(args);
      expect(status).toBe(0);
      const text = stdout.toString();
      expect(text).toContain("ahood doc -- docs (DOC.md) in the ahood registry");
      expect(text).toContain("ahood doc read <owner>/<doc>");
      expect(text).toContain("ahood doc init [name]");
      expect(text).toContain("ahood doc add <owner>/<doc>[@version]");
      expect(text).toContain(".claude/docs/<owner>@<doc>.md");
    }
    expect(run(["doc", "read", "--help"]).stdout.toString()).toMatch(/^ahood doc read <owner>\/<doc>/);
    expect(run(["help", "doc", "publish"]).stdout.toString()).toMatch(/^ahood doc publish <owner>\/<doc>@<version>/);
  });

  it("`ahood doc add alice/..` is refused (exit 2) before any request, writing nothing", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ahood-doc-home-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "ahood-doc-cwd-"));
    try {
      // Exit 2, not 6: refused before any request to the unreachable registry.
      const { status, stderr } = run(["doc", "add", "alice/.."], { cwd, env: offlineEnv(home) });
      expect(status).toBe(2);
      expect(stderr).toContain('Invalid skill ".."');
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("an unknown doc verb fails with a suggestion; completion offers doc and all its verbs", () => {
    const bad = run(["doc", "raed", "x"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Unknown doc command: raed");
    expect(bad.stderr).toContain("Did you mean 'read'?");
    const bash = run(["completion", "bash"]).stdout.toString();
    expect(bash).toMatch(/local top_words="[^"]*\bdoc\b/);
    const docWords = bash.match(/local doc_words="([^"]*)"/)![1].split(" ");
    expect(docWords).toEqual(
      expect.arrayContaining(["search", "list", "view", "show", "read", "init", "publish", "add", "update", "outdated", "remove"]),
    );
    expect(bash).toMatch(/local help_words="[^"]*\bdoc\b/);
  });

});

describe("ahood project command group (ahood-cli#185)", () => {
  it("`ahood --help` lists `ahood project <command>`; `project --help` and `help project` print project help", () => {
    expect(run(["--help"]).stdout.toString()).toContain("ahood project <command>");
    for (const args of [["project", "--help"], ["help", "project"]]) {
      const { stdout, status } = run(args);
      expect(status).toBe(0);
      const text = stdout.toString();
      expect(text).toContain("ahood project -- project guides (PROJECT.md) in the ahood registry");
      expect(text).toContain("ahood project add <owner>/<slug>[@version]");
      expect(text).toContain("ahood project init [name] [--project <git-remote> | --no-project]");
      expect(text).toContain("ahood project [--remote <git-remote>] [--json]");
      expect(text).toContain(".claude/project.md");
      expect(text).toContain("never touches CLAUDE.md or AGENTS.md");
    }
    expect(run(["project", "read", "--help"]).stdout.toString()).toMatch(/^ahood project read <owner>\/<slug>/);
  });

  it("bare `ahood project` outside a git repository is a usage error (exit 2) sent nowhere, writing nothing", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ahood-project-home-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "ahood-project-cwd-"));
    try {
      const { status, stderr } = run(["project"], { cwd, env: offlineEnv(home) });
      expect(status).toBe(2);
      expect(stderr).toContain("No git remote found");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("completion offers project and its verbs, without the bare entry's flags", () => {
    const bash = run(["completion", "bash"]).stdout.toString();
    expect(bash).toMatch(/local top_words="[^"]*\bproject\b/);
    const words = bash.match(/local project_words="([^"]*)"/)![1].split(" ");
    expect(words).toEqual(expect.arrayContaining(["read", "init", "publish", "add", "update", "remove", "show"]));
    expect(words.some((w) => !/^[a-z]/.test(w))).toBe(false);
  });

});

describe("ahood loop command group (ahood-cli, ahood#858)", () => {
  it("`ahood --help` lists `ahood loop <command>`; `ahood loop`, `--help` and `help loop` print loop help", () => {
    expect(run(["--help"]).stdout.toString()).toContain("ahood loop <command>");
    for (const args of [["loop"], ["loop", "--help"], ["help", "loop"]]) {
      const { stdout, status } = run(args);
      expect(status).toBe(0);
      const text = stdout.toString();
      expect(text).toContain("ahood loop -- loops (LOOP.md) in the ahood registry");
      expect(text).toContain("ahood loop read <owner>/<loop>");
      expect(text).toContain("ahood loop init [name]");
      expect(text).toContain("ahood loop add <owner>/<loop>[@version]");
      expect(text).toContain(".claude/loops/<owner>@<loop>.md");
    }
    expect(run(["loop", "read", "--help"]).stdout.toString()).toMatch(/^ahood loop read <owner>\/<loop>/);
    expect(run(["help", "loop", "publish"]).stdout.toString()).toMatch(/^ahood loop publish <owner>\/<loop>@<version>/);
  });

  it("`ahood loop add alice/..` is refused (exit 2) before any request, writing nothing", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ahood-loop-home-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "ahood-loop-cwd-"));
    try {
      // Exit 2, not 6: refused before any request to the unreachable registry.
      const { status, stderr } = run(["loop", "add", "alice/.."], { cwd, env: offlineEnv(home) });
      expect(status).toBe(2);
      expect(stderr).toContain('Invalid skill ".."');
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("an unknown loop verb fails with a suggestion; completion offers loop and all its verbs", () => {
    const bad = run(["loop", "raed", "x"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Unknown loop command: raed");
    expect(bad.stderr).toContain("Did you mean 'read'?");
    const bash = run(["completion", "bash"]).stdout.toString();
    expect(bash).toMatch(/local top_words="[^"]*\bloop\b/);
    const loopWords = bash.match(/local loop_words="([^"]*)"/)![1].split(" ");
    expect(loopWords).toEqual(
      expect.arrayContaining(["search", "list", "view", "show", "read", "init", "publish", "add", "update", "outdated", "remove"]),
    );
    expect(bash).toMatch(/local help_words="[^"]*\bloop\b/);
  });

});

describe("ahood prompt command group (ahood-cli#206)", () => {
  it("`ahood --help` lists `ahood prompt <command>`; `ahood prompt`, `ahood prompts`, `--help` and `help prompt` print prompt help", () => {
    expect(run(["--help"]).stdout.toString()).toContain("ahood prompt <command>");
    for (const args of [["prompt"], ["prompts"], ["prompt", "--help"], ["prompts", "--help"], ["help", "prompt"]]) {
      const { stdout, status } = run(args);
      expect(status).toBe(0);
      const text = stdout.toString();
      expect(text).toContain("ahood prompt -- prompts (PROMPT.md) in the ahood registry");
      expect(text).toContain("ahood prompt get <owner>/<prompt>[@version]");
      expect(text).toContain("ahood prompt read <owner>/<prompt>");
      expect(text).toContain("ahood prompt init [name]");
      expect(text).not.toContain("ahood prompt add");
      expect(text).not.toContain("ahood prompt remove");
    }
    expect(run(["prompt", "get", "--help"]).stdout.toString()).toMatch(/^ahood prompt get <owner>\/<prompt>/);
    expect(run(["help", "prompt", "publish"]).stdout.toString()).toMatch(/^ahood prompt publish <owner>\/<prompt>@<version>/);
  });

  it("`ahood prompts add` is refused (exit 2) before any request, pointing at `ahood prompt get`", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ahood-prompt-home-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "ahood-prompt-cwd-"));
    try {
      // Exit 2, not 6: refused before any request to the unreachable registry.
      const { status, stderr } = run(["prompts", "add", "alice/landing"], { cwd, env: offlineEnv(home) });
      expect(status).toBe(2);
      expect(stderr).toContain("Prompts are never installed, so there is nothing to add.");
      expect(stderr).toContain("ahood prompt get");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("an unknown prompt verb suggests `get`; completion offers prompt and its verbs, without the install verbs", () => {
    const bad = run(["prompt", "gte", "x"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Unknown prompt command: gte");
    expect(bad.stderr).toContain("Did you mean 'get'?");
    const bash = run(["completion", "bash"]).stdout.toString();
    expect(bash).toMatch(/local top_words="[^"]*\bprompt\b/);
    const promptWords = bash.match(/local prompt_words="([^"]*)"/)![1].split(" ");
    expect(promptWords).toEqual(expect.arrayContaining(["get", "search", "list", "view", "show", "read", "init", "publish"]));
    expect(promptWords).not.toContain("add");
    expect(promptWords).not.toContain("remove");
  });

});

describe("npm tarball", () => {
  it("ships the CLI without the removed forms, and the installed CLI is version-matched", () => {
    const work = mkdtempSync(path.join(tmpdir(), "ahood-pack-"));
    try {
      const packJson = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], {
        cwd: root,
        encoding: "utf8",
      });
      const [packed] = JSON.parse(packJson) as Array<{ filename: string; version: string; files: Array<{ path: string }> }>;
      const files = packed.files.map((f) => f.path);
      expect(files).toContain("dist/index.js");
      // ahood#1018 step 2: no bundled raw skill, no local stdio MCP server.
      expect(files.filter((f) => /^dist\/(useme|mcp)(\/|\.)/.test(f))).toEqual([]);

      execFileSync("tar", ["-xzf", path.join(work, packed.filename), "-C", work]);
      const pkgDir = path.join(work, "package");
      // Dependencies come from this checkout rather than the network; the CLI
      // code comes from the tarball alone.
      symlinkSync(path.join(root, "node_modules"), path.join(pkgDir, "node_modules"), "dir");
      const installedCli = path.join(pkgDir, "dist", "index.js");

      const home = path.join(work, "home");
      const cwd = path.join(work, "cwd");
      execFileSync("mkdir", ["-p", home, cwd]);
      expect(run(["--version"], { cli: installedCli }).stdout.toString().trim()).toBe(`@ahood/cli ${packed.version}`);
      const removed = run(["help", "useme"], { cli: installedCli, cwd, env: offlineEnv(home) });
      expect(removed.status).toBe(2);
      expect(removed.stderr).toBe(REMOVED_NOTICE);
      expect(existsSync(path.join(cwd, ".claude"))).toBe(false);
      // ahood-cli#182: the tarball carries the doc group's help.
      const docHelp = run(["doc", "--help"], { cli: installedCli, cwd, env: offlineEnv(home) });
      expect(docHelp.status).toBe(0);
      expect(docHelp.stdout.toString()).toContain("ahood doc -- docs (DOC.md) in the ahood registry");
      expect(run(["--help"], { cli: installedCli }).stdout.toString()).toContain("ahood doc <command>");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
