import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchDoc, dispatchProject, dispatchSkill } from "../src/index.js";
import { KindMismatchError, localInstalledKind, resolveScope } from "../src/kinds.js";
import { readLockfile } from "../src/lockfile.js";
import { LOCKFILE_PATH, PROJECT_GUIDE_PATH } from "../src/spec.js";
import { UsageError } from "../src/usage-error.js";

// `ahood project` (ahood-cli#185): the fifth registry noun, for project guides
// (PROJECT.md: how to work in one repository). Same shared dispatch and
// handlers as `ahood doc`; the differences pinned here are the fixed install
// target (.claude/project.md, one per repository), never touching
// CLAUDE.md/AGENTS.md, `init`'s git-remote prefill, and bare `ahood project`.
vi.mock("../src/confirm.js", () => ({ confirm: vi.fn(async () => true) }));
import { API_URL, entry, fakeRegistry, json, mutations, backendAcceptsDocMd } from "./helpers/fake-registry.js";

const GUIDE = "---\nname: x\ndescription: d\n---\nbody\n";

describe("ahood project (ahood-cli#185)", () => {
  let dir: string;
  let originalCwd: string;
  const saved = { HOME: process.env.HOME, AHOOD_API_URL: process.env.AHOOD_API_URL, AHOOD_TOKEN: process.env.AHOOD_TOKEN };

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-project-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.exitCode = 0;
  });

  function quiet() {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  }

  function gitRepoWithOrigin(url: string): void {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
  }

  it("the project noun is strict for kind project and refuses a contradictory --kind", () => {
    expect(resolveScope("project", undefined)).toEqual({ noun: "project", kind: "project" });
    expect(() => resolveScope("project", "doc")).toThrow(/--kind doc contradicts it/);
    expect(resolveScope("skill", "project")).toEqual({ noun: "skill", kind: "project" });
  });

  describe("install: add, update, remove", () => {
    it("project add writes PROJECT.md to .claude/project.md, pins it with kind project, and leaves CLAUDE.md/AGENTS.md alone", async () => {
      quiet();
      writeFileSync("CLAUDE.md", "my claude");
      writeFileSync("AGENTS.md", "my agents");
      fakeRegistry({ "alice/acme": await entry("project") });
      await dispatchProject(["add", "alice/acme"]);
      expect(PROJECT_GUIDE_PATH).toBe(join(".claude", "project.md"));
      expect(readFileSync(PROJECT_GUIDE_PATH, "utf8")).toBe(GUIDE);
      const pin = readLockfile(LOCKFILE_PATH)["alice/acme"];
      expect(pin).toMatchObject({ version: "1.0.0", kind: "project" });
      expect(localInstalledKind("alice", "acme", pin)).toBe("project");
      expect(readFileSync("CLAUDE.md", "utf8")).toBe("my claude");
      expect(readFileSync("AGENTS.md", "utf8")).toBe("my agents");
      expect(readdirSync(".claude").sort()).toEqual(["project.md", "skills.lock.json"]);
    });

    it("project add of a pinned version installs that version", async () => {
      quiet();
      fakeRegistry({ "alice/acme": await entry("project", "1.2.0") });
      await dispatchProject(["add", "alice/acme@1.2.0"]);
      expect(readLockfile(LOCKFILE_PATH)["alice/acme"]?.version).toBe("1.2.0");
    });

    it("refuses to overwrite an unpinned .claude/project.md, before downloading", async () => {
      quiet();
      mkdirSync(".claude");
      writeFileSync(PROJECT_GUIDE_PATH, "mine");
      const calls = fakeRegistry({ "alice/acme": await entry("project") });
      await expect(dispatchProject(["add", "alice/acme"])).rejects.toThrow(/already exists and is not pinned as alice\/acme/);
      expect(readFileSync(PROJECT_GUIDE_PATH, "utf8")).toBe("mine");
      expect(mutations(calls)).toEqual([]);
      expect(existsSync(LOCKFILE_PATH)).toBe(false);
    });

    it("refuses a second project guide while another one is installed, naming it", async () => {
      quiet();
      fakeRegistry({ "alice/acme": await entry("project"), "bob/other": await entry("project") });
      await dispatchProject(["add", "alice/acme"]);
      await expect(dispatchProject(["add", "bob/other"])).rejects.toThrow(
        /alice\/acme is already installed at .*project\.md.*ahood project remove alice\/acme/,
      );
      expect(readFileSync(PROJECT_GUIDE_PATH, "utf8")).toBe(GUIDE);
      expect(Object.keys(readLockfile(LOCKFILE_PATH))).toEqual(["alice/acme"]);
    });

    it("project update moves the guide forward; legacy skill update does too, through the project path", async () => {
      quiet();
      fakeRegistry({ "alice/acme": await entry("project"), "alice/rev": await entry("agent") });
      await dispatchProject(["add", "alice/acme"]);
      fakeRegistry({ "alice/acme": await entry("project", "2.0.0"), "alice/rev": await entry("agent", "2.0.0") });
      await dispatchProject(["update"]);
      expect(readLockfile(LOCKFILE_PATH)["alice/acme"]).toMatchObject({ version: "2.0.0", kind: "project" });

      fakeRegistry({ "alice/acme": await entry("project", "3.0.0") });
      await dispatchSkill(["update"]);
      expect(readLockfile(LOCKFILE_PATH)["alice/acme"]).toMatchObject({ version: "3.0.0", kind: "project" });
      expect(existsSync(join(".claude", "skills"))).toBe(false);
    });

    it("project remove deletes the file and the pin, offline; doc remove of it is refused; skill remove works", async () => {
      quiet();
      fakeRegistry({ "alice/acme": await entry("project") });
      await dispatchProject(["add", "alice/acme"]);
      const calls = fakeRegistry({});
      await expect(dispatchDoc(["remove", "alice/acme", "--yes"])).rejects.toThrow(/alice\/acme is a project guide, not a doc/);
      expect(existsSync(PROJECT_GUIDE_PATH)).toBe(true);
      await dispatchProject(["remove", "alice/acme", "--yes"]);
      expect(existsSync(PROJECT_GUIDE_PATH)).toBe(false);
      expect(readLockfile(LOCKFILE_PATH)["alice/acme"]).toBeUndefined();
      expect(calls).toEqual([]);

      fakeRegistry({ "alice/acme": await entry("project") });
      await dispatchProject(["add", "alice/acme"]);
      await dispatchSkill(["remove", "alice/acme", "--yes"]);
      expect(existsSync(PROJECT_GUIDE_PATH)).toBe(false);
    });

    it("removing some other key never deletes the project guide it does not own", async () => {
      quiet();
      mkdirSync(".claude");
      writeFileSync(PROJECT_GUIDE_PATH, "mine");
      fakeRegistry({});
      await dispatchSkill(["remove", "alice/acme", "--yes"]);
      expect(readFileSync(PROJECT_GUIDE_PATH, "utf8")).toBe("mine");
    });

    it("legacy `ahood skill add` of a project guide is refused before any download, pointing at project add", async () => {
      quiet();
      const calls = fakeRegistry({ "alice/acme": await entry("project") });
      const error = await dispatchSkill(["add", "alice/acme"]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toBe(
        "alice/acme is a project guide (a guide to working in one repository), not a skill. " +
          "Install it with `ahood project add alice/acme`, or read it without installing with `ahood project read alice/acme`.",
      );
      expect(mutations(calls)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("project add of a skill or a doc, and doc add of a project guide, are refused before any download", async () => {
      quiet();
      const calls = fakeRegistry({
        "alice/pdf": await entry("skill"),
        "alice/guide": await entry("doc"),
        "alice/acme": await entry("project"),
      });
      await expect(dispatchProject(["add", "alice/pdf"])).rejects.toThrow(
        /alice\/pdf is a skill, not a project guide -- refusing to install it\. Use `ahood skill add alice\/pdf` instead\./,
      );
      await expect(dispatchProject(["add", "alice/guide"])).rejects.toThrow(KindMismatchError);
      await expect(dispatchDoc(["add", "alice/acme"])).rejects.toThrow(/alice\/acme is a project guide, not a doc/);
      expect(mutations(calls)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  describe("read verbs", () => {
    it("search asks for ?kind=project; list for the owner's guides; read prints PROJECT.md", async () => {
      quiet();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const calls = fakeRegistry({ "alice/acme": await entry("project") });
      await dispatchProject(["search", "acme"]);
      expect(new URL(calls[0].url).searchParams.get("kind")).toBe("project");
      await dispatchProject(["list", "--json"]);
      expect(new URL(calls[1].url).searchParams.get("kind")).toBe("project");
      await dispatchProject(["read", "alice/acme"]);
      await dispatchProject(["show", "alice/acme", "--json"]);
      expect(stdout).toHaveBeenCalled();
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });
  });

  describe("publish", () => {
    it("project publish of a new entry creates it with kind project", async () => {
      quiet();
      mkdirSync("p");
      writeFileSync(join("p", "PROJECT.md"), GUIDE);
      const calls = fakeRegistry({});
      await dispatchProject(["publish", "alice/acme@1.0.0", "--path", "p", "--name", "Acme"]);
      const create = calls.find((c) => c.method === "POST" && new URL(c.url).pathname === "/api/v1/skills");
      expect(JSON.parse(create!.body!).kind).toBe("project");
    });

    it("legacy publish infers project from a PROJECT.md-only folder and accepts --kind project", async () => {
      quiet();
      mkdirSync("p");
      writeFileSync(join("p", "PROJECT.md"), GUIDE);
      for (const extra of [[], ["--kind", "project"]]) {
        vi.unstubAllGlobals();
        const calls = fakeRegistry({});
        await dispatchSkill(["publish", "alice/acme@1.0.0", "--path", "p", "--name", "Acme", ...extra]);
        const create = calls.find((c) => c.method === "POST" && new URL(c.url).pathname === "/api/v1/skills");
        expect(JSON.parse(create!.body!).kind).toBe("project");
      }
    });

    it("a folder with PROJECT.md next to another root doc is ambiguous; project publish needs PROJECT.md", async () => {
      quiet();
      mkdirSync("p");
      writeFileSync(join("p", "PROJECT.md"), GUIDE);
      writeFileSync(join("p", "DOC.md"), GUIDE);
      const calls = fakeRegistry({});
      await expect(dispatchSkill(["publish", "alice/acme@1.0.0", "--path", "p"])).rejects.toThrow(
        /Multiple root files found .*DOC\.md, PROJECT\.md.*--kind project/,
      );
      mkdirSync("d");
      writeFileSync(join("d", "DOC.md"), GUIDE);
      await expect(dispatchProject(["publish", "alice/acme@1.0.0", "--path", "d"])).rejects.toThrow(
        /No PROJECT.md found .* ahood project publish must point at a folder containing PROJECT.md/,
      );
      expect(calls).toEqual([]);
    });
  });

  describe("init", () => {
    it("writes a PROJECT.md the backend accepts, prefilling `project` from origin without ever printing its credentials", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      gitRepoWithOrigin("https://user:s3cret-token@GitHub.com/Alice/Acme-API.git");
      await dispatchProject(["init", "acme"]);
      const md = readFileSync(join("acme", "PROJECT.md"), "utf8");
      expect(backendAcceptsDocMd(md)).toBe(true);
      expect(md).toMatch(/^---\nname: acme\ndescription: .+\nproject: github\.com\/alice\/acme-api\n---\n/);
      const out = log.mock.calls.flat().join("\n");
      expect(out).toContain("github.com/alice/acme-api");
      expect(out).toContain("ahood project publish <owner>/<slug>@<version> --path acme");
      expect(out + md).not.toContain("s3cret-token");
    });

    it("--no-project leaves the field out; --project sets it, normalized; a bad --project is refused without echoing it", async () => {
      quiet();
      gitRepoWithOrigin("git@github.com:alice/acme.git");
      await dispatchProject(["init", "a", "--no-project"]);
      expect(readFileSync(join("a", "PROJECT.md"), "utf8")).not.toContain("project:");
      await dispatchProject(["init", "b", "--project", "https://GitLab.example.org/Team/Sub/Repo.git"]);
      expect(readFileSync(join("b", "PROJECT.md"), "utf8")).toContain("\nproject: gitlab.example.org/team/sub/repo\n");
      const error = await dispatchProject(["init", "c", "--project", "https://u:t0ken@nope?x"]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).not.toContain("t0ken");
      expect(existsSync("c")).toBe(false);
    });

    it("outside a git repository the field is simply left out", async () => {
      quiet();
      await dispatchProject(["init"]);
      const md = readFileSync("PROJECT.md", "utf8");
      expect(backendAcceptsDocMd(md)).toBe(true);
      expect(md).not.toContain("project:");
    });
  });

  describe("bare `ahood project`: guides for this repository's remote", () => {
    function fakeMcp(result: unknown, isError = false) {
      const calls: Array<{ url: string; body: string; headers: Headers }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          calls.push({ url: String(input), body: String(init.body), headers: new Headers(init.headers) });
          return json({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: JSON.stringify(result) }], ...(isError ? { isError: true } : {}) },
          });
        }),
      );
      return calls;
    }

    const guides = {
      project: "github.com/alice/acme",
      guides: [
        { owner: "alice", slug: "acme", name: "Acme", tagline: "How we work", project: "github.com/alice/acme", visibility: "private", version: "1.0.0", content: GUIDE, mine: true },
      ],
    };

    it("asks get_project_guide for origin's normalized remote -- never the raw URL -- and lists the guides", async () => {
      gitRepoWithOrigin("https://user:s3cret-token@github.com/Alice/Acme.git");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const calls = fakeMcp(guides);
      await dispatchProject([]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/mcp`);
      const rpc = JSON.parse(calls[0].body);
      expect(rpc).toMatchObject({ method: "tools/call", params: { name: "get_project_guide", arguments: { remote: "github.com/alice/acme" } } });
      expect(calls[0].body).not.toContain("s3cret-token");
      const out = log.mock.calls.flat().join("\n");
      expect(out).toContain("alice/acme@1.0.0");
      expect(out).toContain("ahood project add alice/acme");
      expect(out).not.toContain("s3cret-token");
      expect(readdirSync(dir)).toEqual([".git"]);
    });

    it("--remote overrides origin, --json prints the result, and no guides is not an error", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      let calls = fakeMcp(guides);
      await dispatchProject(["--remote", "git@github.com:alice/acme.git", "--json"]);
      expect(JSON.parse(calls[0].body).params.arguments).toEqual({ remote: "github.com/alice/acme" });
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual(guides);

      vi.unstubAllGlobals();
      calls = fakeMcp({ project: "github.com/alice/none", guides: [] });
      await dispatchProject(["--remote", "github.com/alice/none"]);
      expect(log.mock.calls.flat().join("\n")).toContain("No project guides found for github.com/alice/none");
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("outside a git repository it is a usage error, sent nowhere; a tool error surfaces as an error", async () => {
      const calls = fakeMcp(guides);
      await expect(dispatchProject([])).rejects.toThrow(UsageError);
      await expect(dispatchProject(["--remote", "not a remote"])).rejects.toThrow(UsageError);
      expect(calls).toEqual([]);

      vi.unstubAllGlobals();
      fakeMcp({ error: "boom" }, true);
      await expect(dispatchProject(["--remote", "github.com/a/b"])).rejects.toThrow(/boom/);
    });
  });
});
