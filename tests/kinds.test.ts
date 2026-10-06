import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { dispatchAgent, dispatchMcp, dispatchSkill } from "../src/index.js";
import {
  assertKind,
  extractKindFlag,
  KindMismatchError,
  LEGACY_SCOPE,
  localInstalledKind,
  resolveScope,
} from "../src/kinds.js";
import { readLockfile, writeLockfileEntry } from "../src/lockfile.js";
import { agentPath, skillDir, LOCKFILE_PATH } from "../src/spec.js";
import { UsageError } from "../src/usage-error.js";
import { hashMcpServerConfig } from "../src/commands/add.js";

// Every kind-scoped verb (ahood-cli#172) must refuse a target of another kind
// BEFORE its first side effect. The fake registry below records every request
// (method + URL), so "no side effect" is checked as "no non-GET request and no
// download", and the temp project directory is checked for untouched files.
vi.mock("../src/confirm.js", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../src/secret-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/secret-prompt.js")>();
  return { ...actual, promptSecret: vi.fn(async () => "prompted") };
});
import { confirm } from "../src/confirm.js";

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

type Entry = {
  kind: string | undefined; // undefined = the response omits `kind` entirely
  version: string;
  archive: Buffer;
  rootDoc: string;
};

type Call = { method: string; url: string; body?: string };

const ROOT_DOCS: Record<string, string> = { skill: "SKILL.md", agent: "AGENT.md", mcp: "server.json" };

async function entry(kind: string | undefined, version = "1.0.0", contentKind = kind ?? "skill"): Promise<Entry> {
  const rootDoc = ROOT_DOCS[contentKind];
  const content =
    contentKind === "mcp"
      ? JSON.stringify({ name: "srv", description: "d", remotes: [{ url: "https://mcp.example.com/mcp" }] })
      : `---\nname: x\ndescription: d\n---\nbody\n`;
  return { kind, version, archive: await tarGz({ [rootDoc]: content }), rootDoc };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A small fake of the REST surface the registry verbs use. `mine` is what
// GET ?mine=true returns.
function fakeRegistry(entries: Record<string, Entry>, mine: unknown[] = []) {
  const calls: Call[] = [];
  const created = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init.body === "string" ? init.body : undefined });
      const u = new URL(url);
      if (u.origin === "http://upload.test") return new Response(null, { status: 200 });
      const parts = u.pathname.replace(/^\/api\/v1\/skills\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
      if (parts.length === 0) {
        if (method === "POST") {
          const slug = JSON.parse(init.body as string).slug;
          created.add(`alice/${slug}`);
          return json({ id: "id", slug, owner: "alice" }, 201);
        }
        if (u.searchParams.get("mine") === "true") return json({ skills: mine });
        return json({ skills: [{ slug: "found", name: "Found", tagline: null, downloads_count: 1, profiles: { username: "alice" } }] });
      }
      const key = `${parts[0]}/${parts[1]}`;
      const e = entries[key];
      const rest = parts.slice(2);
      const exists = e !== undefined || created.has(key);
      if (rest[0] === "versions" && rest[1] === "init") {
        return exists ? json({ upload_url: "http://upload.test/put", storage_path: "s", version_id: "v1" }) : json({ error: "Not found" }, 404);
      }
      if (rest[0] === "versions" && rest[1] === "complete") return json({ version_id: "v1", status: "processing" }, 202);
      if (!e && created.has(key) && rest[0] === "versions") return json({ version: rest[1], status: "published" });
      if (!e) return json({ error: "Not found" }, 404);
      const checksum = createHash("sha256").update(e.archive).digest("hex");
      const versionRow = { version: e.version, manifest: [{ path: e.rootDoc }], checksum_sha256: checksum, skill_md_content: "doc", changelog_md: null };
      const kindField = e.kind === undefined ? {} : { kind: e.kind };
      if (rest.length === 0) {
        if (method === "GET") return json({ slug: parts[1], owner: parts[0], name: "N", tags: [], skill_versions: versionRow, ...kindField });
        if (method === "PATCH") return json({ slug: parts[1], tagline: null, license: null, visibility: "public", tags: [] });
        return json({ ok: true });
      }
      if (rest[0] === "download") return new Response(new Uint8Array(e.archive), { status: 200 });
      if (rest[0] === "versions" && rest.length === 1) return json({ versions: [{ version: e.version, created_at: "t", package_size_bytes: 1, changelog_md: null }] });
      if (rest[0] === "versions") {
        if (method === "GET") return json({ ...versionRow, yanked_at: null, status: "published", ...kindField });
        return json({ ok: true });
      }
      if (rest[0] === "star") return json({ starred: method === "POST" });
      if (rest[0] === "share") return json({ shared: method === "POST" });
      return json({ error: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

function mutations(calls: Call[]): Call[] {
  return calls.filter((c) => c.method !== "GET" || c.url.includes("/download"));
}

describe("kind scope resolution", () => {
  it("skill noun is legacy (cross-kind) by default and with --kind all; --kind narrows it", () => {
    expect(resolveScope("skill", undefined)).toEqual(LEGACY_SCOPE);
    expect(resolveScope("skill", "all")).toEqual(LEGACY_SCOPE);
    expect(resolveScope("skill", "agent")).toEqual({ noun: "skill", kind: "agent" });
  });

  it("agent/mcp nouns are strict and refuse a contradictory --kind", () => {
    expect(resolveScope("agent", undefined)).toEqual({ noun: "agent", kind: "agent" });
    expect(resolveScope("mcp", "mcp")).toEqual({ noun: "mcp", kind: "mcp" });
    expect(() => resolveScope("agent", "mcp")).toThrow(UsageError);
    expect(() => resolveScope("mcp", "all")).toThrow(/contradicts/);
    expect(() => resolveScope("skill", "doc")).toThrow(/--kind must be one of/);
  });

  it("extractKindFlag strips both --kind forms and refuses a repeat or a missing value", () => {
    expect(extractKindFlag(["a/b", "--kind", "agent", "--json"])).toEqual({ kind: "agent", rest: ["a/b", "--json"] });
    expect(extractKindFlag(["--kind=mcp", "a/b"])).toEqual({ kind: "mcp", rest: ["a/b"] });
    expect(extractKindFlag(["a/b"])).toEqual({ kind: undefined, rest: ["a/b"] });
    expect(() => extractKindFlag(["--kind", "a", "--kind", "b"])).toThrow(/more than once/);
    expect(() => extractKindFlag(["--kind", "--json"])).toThrow(/requires a value/);
  });

  it("assertKind: a legacy scope never refuses; strict refuses mismatch (exit-2 class), missing and unknown kinds (plain Error)", () => {
    expect(() => assertKind(LEGACY_SCOPE, "a/b", "agent", "add", "install")).not.toThrow();
    expect(() => assertKind(LEGACY_SCOPE, "a/b", undefined, "add", "install")).not.toThrow();
    const strict = { noun: "agent", kind: "agent" } as const;
    expect(() => assertKind(strict, "a/b", "agent", "add", "install")).not.toThrow();
    expect(() => assertKind(strict, "a/b", "skill", "add", "install")).toThrow(KindMismatchError);
    expect(() => assertKind(strict, "a/b", "skill", "add", "install")).toThrow(
      "a/b is a skill, not an agent -- refusing to install it. Use `ahood skill add a/b` instead.",
    );
    for (const bad of [undefined, null, "", "doc", 42]) {
      let thrown: unknown;
      try {
        assertKind(strict, "a/b", bad, "add", "install");
      } catch (error) {
        thrown = error;
      }
      expect(thrown, String(bad)).toBeInstanceOf(Error);
      expect(thrown, String(bad)).not.toBeInstanceOf(UsageError);
    }
  });
});

describe("kind-scoped registry verbs", () => {
  let dir: string;
  let originalCwd: string;
  const saved = { HOME: process.env.HOME, AHOOD_API_URL: process.env.AHOOD_API_URL, AHOOD_TOKEN: process.env.AHOOD_TOKEN };

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-kinds-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
    process.exitCode = 0;
    vi.mocked(confirm).mockClear();
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

  describe("add", () => {
    it("agent add installs an agent to .claude/agents", async () => {
      quiet();
      fakeRegistry({ "alice/rev": await entry("agent") });
      await dispatchAgent(["add", "alice/rev"]);
      expect(existsSync(agentPath("alice", "rev"))).toBe(true);
      expect(readLockfile(LOCKFILE_PATH)["alice/rev"]?.version).toBe("1.0.0");
    });

    it("mcp add installs an mcp entry into .mcp.json", async () => {
      quiet();
      fakeRegistry({ "alice/srv": await entry("mcp") });
      await dispatchMcp(["add", "alice/srv"]);
      const mcpJson = JSON.parse(readFileSync(".mcp.json", "utf8"));
      expect(mcpJson.mcpServers.srv).toEqual({ url: "https://mcp.example.com/mcp" });
    });

    it("agent add of a skill is refused before any download or write (latest and pinned version)", async () => {
      quiet();
      const calls = fakeRegistry({ "alice/pdf": await entry("skill") });
      await expect(dispatchAgent(["add", "alice/pdf"])).rejects.toThrow(KindMismatchError);
      await expect(dispatchAgent(["add", "alice/pdf@1.0.0"])).rejects.toThrow(/is a skill, not an agent/);
      expect(mutations(calls)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("mcp add refuses an entry whose response carries no kind, without installing it", async () => {
      quiet();
      const calls = fakeRegistry({ "alice/nokind": await entry(undefined) });
      await expect(dispatchMcp(["add", "alice/nokind"])).rejects.toThrow(/did not report a kind/);
      expect(mutations(calls)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("legacy `ahood skill add` still installs an agent (cross-kind preserved); --kind skill makes it strict", async () => {
      quiet();
      const calls = fakeRegistry({ "alice/rev": await entry("agent") });
      await dispatchSkill(["add", "alice/rev"]);
      expect(existsSync(agentPath("alice", "rev"))).toBe(true);
      rmSync(".claude", { recursive: true, force: true });
      calls.length = 0;
      await expect(dispatchSkill(["add", "alice/rev", "--kind", "skill"])).rejects.toThrow(/is an agent, not a skill/);
      expect(mutations(calls)).toEqual([]);
    });

    it("rewrites the handler's usage line to the noun the user typed", async () => {
      await expect(dispatchAgent(["add"])).rejects.toThrow(/^Usage: ahood agent add /);
      await expect(dispatchMcp(["add", "not-a-spec"])).rejects.toThrow(/^Usage: ahood mcp add /);
    });
  });

  describe("remote-entry verbs refuse another kind before mutating", () => {
    const cases: Array<[string, string[]]> = [
      ["edit", ["edit", "alice/pdf", "--tagline", "x"]],
      ["unpublish", ["unpublish", "alice/pdf", "--yes"]],
      ["unpublish@version", ["unpublish", "alice/pdf@1.0.0", "--yes"]],
      ["star", ["star", "alice/pdf"]],
      ["unstar", ["unstar", "alice/pdf"]],
      ["share", ["share", "alice/pdf", "--group", "team"]],
      ["unshare", ["unshare", "alice/pdf", "--group", "team"]],
      ["view", ["view", "alice/pdf", "--json"]],
      ["read", ["read", "alice/pdf"]],
      ["versions", ["versions", "alice/pdf"]],
      ["diff", ["diff", "alice/pdf", "1.0.0", "1.0.0"]],
    ];
    for (const [name, argv] of cases) {
      it(`agent ${name} of a skill: refused, no non-GET request, no prompt`, async () => {
        quiet();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const calls = fakeRegistry({ "alice/pdf": await entry("skill") });
        await expect(dispatchAgent(argv)).rejects.toThrow(KindMismatchError);
        expect(mutations(calls)).toEqual([]);
        expect(confirm).not.toHaveBeenCalled();
        expect(stdout).not.toHaveBeenCalled();
      });
    }

    it("the same verbs go through for the right kind (edit/unpublish/star/share reach their mutation)", async () => {
      quiet();
      const calls = fakeRegistry({ "alice/rev": await entry("agent") });
      await dispatchAgent(["edit", "alice/rev", "--tagline", "x"]);
      await dispatchAgent(["star", "alice/rev"]);
      await dispatchAgent(["share", "alice/rev", "--group", "team"]);
      await dispatchAgent(["unpublish", "alice/rev", "--yes"]);
      expect(mutations(calls).map((c) => c.method)).toEqual(["PATCH", "POST", "POST", "DELETE"]);
    });

    it("legacy `ahood skill edit` sends no kind preflight -- the request sequence is exactly the pre-#172 one", async () => {
      quiet();
      const calls = fakeRegistry({ "alice/rev": await entry("agent") });
      await dispatchSkill(["edit", "alice/rev", "--tagline", "x"]);
      expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    });
  });

  describe("search and list", () => {
    it("agent search asks the registry for ?kind=agent; legacy skill search sends no kind", async () => {
      quiet();
      const calls = fakeRegistry({});
      await dispatchAgent(["search", "review"]);
      await dispatchSkill(["search", "review"]);
      await dispatchSkill(["search", "review", "--kind", "mcp"]);
      const qs = calls.map((c) => new URL(c.url).searchParams);
      expect(qs[0].get("kind")).toBe("agent");
      expect(qs[1].has("kind")).toBe(false);
      expect(qs[2].get("kind")).toBe("mcp");
    });

    it("mcp list keeps only owned mcp entries (same --json shape); legacy skill list keeps every kind", async () => {
      const rows = [
        { slug: "a", name: "A", tagline: null, visibility: "public", kind: "skill", downloads_count: 0, stars_count: 0, profiles: { username: "alice" } },
        { slug: "b", name: "B", tagline: null, visibility: "private", kind: "mcp", downloads_count: 0, stars_count: 0, profiles: { username: "alice" } },
        { slug: "c", name: "C", tagline: null, visibility: "private", downloads_count: 0, stars_count: 0, profiles: { username: "alice" } },
      ];
      fakeRegistry({}, rows);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await dispatchMcp(["list", "--json"]);
      expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual([rows[1]]);
      expect(String(warn.mock.calls[0][0])).toMatch(/1 of your entries had no kind/);
      log.mockClear();
      await dispatchSkill(["list", "--json"]);
      expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(rows);
      log.mockClear();
      await dispatchAgent(["list"]);
      expect(log).toHaveBeenCalledWith("You haven't published any agents yet.");
    });
  });

  describe("remove", () => {
    function installSkillOnDisk() {
      mkdirSync(skillDir("alice", "pdf"), { recursive: true });
      writeFileSync(join(skillDir("alice", "pdf"), "SKILL.md"), "x");
      writeLockfileEntry(LOCKFILE_PATH, "alice/pdf", { version: "1.0.0", checksum_sha256: "c" });
    }

    it("agent remove of an installed skill is refused offline, before the prompt, touching nothing", async () => {
      quiet();
      installSkillOnDisk();
      const calls = fakeRegistry({});
      await expect(dispatchAgent(["remove", "alice/pdf"])).rejects.toThrow(/is a skill, not an agent/);
      expect(confirm).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(existsSync(join(skillDir("alice", "pdf"), "SKILL.md"))).toBe(true);
      expect(readLockfile(LOCKFILE_PATH)["alice/pdf"]).toBeDefined();
    });

    it("an ambiguous pin (no files, no mcp fingerprint) is resolved through the registry", async () => {
      quiet();
      writeLockfileEntry(LOCKFILE_PATH, "alice/old", { version: "1.0.0", checksum_sha256: "c" });
      fakeRegistry({ "alice/old": await entry("skill") });
      await expect(dispatchMcp(["remove", "alice/old", "--yes"])).rejects.toThrow(KindMismatchError);
      expect(readLockfile(LOCKFILE_PATH)["alice/old"]).toBeDefined();
    });

    it("an ambiguous pin the registry can't confirm is left alone, pointing at the legacy command", async () => {
      quiet();
      writeLockfileEntry(LOCKFILE_PATH, "alice/gone", { version: "1.0.0", checksum_sha256: "c" });
      fakeRegistry({});
      await expect(dispatchMcp(["remove", "alice/gone", "--yes"])).rejects.toThrow(/Nothing was removed.*ahood skill remove alice\/gone/);
      expect(readLockfile(LOCKFILE_PATH)["alice/gone"]).toBeDefined();
    });

    it("mcp remove of an mcp install (fingerprinted pin) removes it", async () => {
      quiet();
      const config = { url: "https://mcp.example.com/mcp" };
      writeFileSync(".mcp.json", JSON.stringify({ mcpServers: { srv: config } }));
      writeLockfileEntry(LOCKFILE_PATH, "alice/srv", { version: "1.0.0", checksum_sha256: "c", mcp_config_hash: hashMcpServerConfig(config) });
      const calls = fakeRegistry({});
      await dispatchMcp(["remove", "alice/srv", "--yes"]);
      expect(calls).toEqual([]);
      expect(JSON.parse(readFileSync(".mcp.json", "utf8")).mcpServers).toEqual({});
      expect(readLockfile(LOCKFILE_PATH)["alice/srv"]).toBeUndefined();
    });

    it("legacy skill remove still removes whatever kind is installed", async () => {
      quiet();
      mkdirSync(join(".claude", "agents"), { recursive: true });
      writeFileSync(agentPath("alice", "rev"), "x");
      writeLockfileEntry(LOCKFILE_PATH, "alice/rev", { version: "1.0.0", checksum_sha256: "c" });
      await dispatchSkill(["remove", "alice/rev", "--yes"]);
      expect(existsSync(agentPath("alice", "rev"))).toBe(false);
    });

    it("localInstalledKind reads the footprint and admits ambiguity", () => {
      expect(localInstalledKind("a", "b", undefined)).toBeUndefined();
      expect(localInstalledKind("a", "b", { version: "1", checksum_sha256: "c", mcp_config_hash: "h" })).toBe("mcp");
      mkdirSync(skillDir("a", "b"), { recursive: true });
      expect(localInstalledKind("a", "b", undefined)).toBe("skill");
      mkdirSync(join(".claude", "agents"), { recursive: true });
      writeFileSync(agentPath("a", "b"), "x");
      expect(localInstalledKind("a", "b", undefined)).toBeUndefined();
    });
  });

  describe("update / outdated", () => {
    async function project() {
      // A skill install, an agent install, and a bare pin whose kind only
      // the registry knows (it says mcp).
      mkdirSync(skillDir("alice", "pdf"), { recursive: true });
      writeLockfileEntry(LOCKFILE_PATH, "alice/pdf", { version: "0.9.0", checksum_sha256: "c" });
      mkdirSync(join(".claude", "agents"), { recursive: true });
      writeFileSync(agentPath("alice", "rev"), "old");
      writeLockfileEntry(LOCKFILE_PATH, "alice/rev", { version: "0.9.0", checksum_sha256: "c" });
      writeLockfileEntry(LOCKFILE_PATH, "alice/legacy", { version: "0.9.0", checksum_sha256: "c" });
      return fakeRegistry({
        "alice/pdf": await entry("skill"),
        "alice/rev": await entry("agent"),
        "alice/legacy": await entry("mcp"),
      });
    }

    it("no-arg `agent outdated --json` previews only installed agents; the skill pin is never even requested", async () => {
      const calls = await project();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchAgent(["outdated", "--json"]);
      const previews = JSON.parse(log.mock.calls[0][0] as string);
      expect(previews.map((p: { skill: string }) => p.skill)).toEqual(["alice/rev"]);
      expect(calls.some((c) => c.url.includes("/alice/pdf"))).toBe(false);
      expect(process.exitCode).toBe(0);
    });

    it("no-arg `agent update` moves only the agent pin; skill and mcp pins are untouched", async () => {
      quiet();
      const calls = await project();
      await dispatchAgent(["update"]);
      const lock = readLockfile(LOCKFILE_PATH);
      expect(lock["alice/rev"].version).toBe("1.0.0");
      expect(lock["alice/pdf"].version).toBe("0.9.0");
      expect(lock["alice/legacy"].version).toBe("0.9.0");
      expect(calls.filter((c) => c.url.includes("/download")).map((c) => c.url)).toEqual([
        `${API_URL}/api/v1/skills/alice/rev/download?version=1.0.0`,
      ]);
      expect(process.exitCode).toBe(0);
    });

    it("no-arg `mcp outdated` picks up the ambiguous pin the registry says is mcp", async () => {
      await project();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchMcp(["outdated", "--json"]);
      expect(JSON.parse(log.mock.calls[0][0] as string).map((p: { skill: string }) => p.skill)).toEqual(["alice/legacy"]);
    });

    it("legacy no-arg `skill outdated` still covers every pin", async () => {
      await project();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchSkill(["outdated", "--json"]);
      expect(JSON.parse(log.mock.calls[0][0] as string)).toHaveLength(3);
    });

    it("an explicit wrong-kind target is refused as a failure, nothing downloaded", async () => {
      quiet();
      const calls = await project();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await dispatchAgent(["update", "alice/pdf"]);
      expect(process.exitCode).toBe(1);
      expect(error.mock.calls.flat().join("\n")).toMatch(/alice\/pdf is a skill, not an agent/);
      expect(calls.some((c) => c.url.includes("/download"))).toBe(false);
      expect(readLockfile(LOCKFILE_PATH)["alice/pdf"].version).toBe("0.9.0");
    });

    it("reports 'No installed agents to update.' when the project has none", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      mkdirSync(skillDir("alice", "pdf"), { recursive: true });
      writeLockfileEntry(LOCKFILE_PATH, "alice/pdf", { version: "0.9.0", checksum_sha256: "c" });
      fakeRegistry({});
      await dispatchAgent(["update"]);
      expect(log).toHaveBeenCalledWith("No installed agents to update.");
    });
  });

  describe("publish", () => {
    function agentFolder() {
      mkdirSync("rev");
      writeFileSync(join("rev", "AGENT.md"), "---\nname: rev\ndescription: d\n---\n");
    }

    it("agent publish onto an existing skill is refused before init/upload", async () => {
      quiet();
      agentFolder();
      const calls = fakeRegistry({ "alice/pdf": await entry("skill") });
      await expect(dispatchAgent(["publish", "alice/pdf@1.1.0", "--path", "rev"])).rejects.toThrow(
        /alice\/pdf is a skill, not an agent -- refusing to publish a new version of it/,
      );
      expect(mutations(calls)).toEqual([]);
    });

    it("agent publish of a new entry creates it with kind agent", async () => {
      quiet();
      agentFolder();
      const calls = fakeRegistry({});
      // Preflight GET 404s (entry absent) -> versions/init 404s -> create
      // (carrying the implied kind) -> init retry -> upload -> complete -> poll.
      await dispatchAgent(["publish", "alice/rev@1.0.0", "--path", "rev", "--name", "Rev"]);
      const create = calls.find((c) => c.method === "POST" && new URL(c.url).pathname === "/api/v1/skills");
      expect(create).toBeDefined();
      expect(JSON.parse(create!.body!).kind).toBe("agent");
      expect(calls[0]).toMatchObject({ method: "GET", url: `${API_URL}/api/v1/skills/alice/rev` });
    });

    it("agent publish refuses a contradictory --kind and a folder without AGENT.md", async () => {
      quiet();
      const calls = fakeRegistry({});
      await expect(dispatchAgent(["publish", "alice/rev@1.0.0", "--kind", "skill"])).rejects.toThrow(/contradicts/);
      mkdirSync("s");
      writeFileSync(join("s", "SKILL.md"), "x");
      await expect(dispatchAgent(["publish", "alice/rev@1.0.0", "--path", "s"])).rejects.toThrow(
        /No AGENT.md found .* ahood agent publish must point at a folder containing AGENT.md/,
      );
      expect(mutations(calls)).toEqual([]);
    });

    it("legacy skill publish sends no preflight: its first request is still versions/init", async () => {
      quiet();
      agentFolder();
      const calls = fakeRegistry({ "alice/rev": await entry("agent") });
      await dispatchSkill(["publish", "alice/rev@1.1.0", "--path", "rev"]).catch(() => {});
      expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/alice/rev/versions/init`);
    });
  });

  describe("init", () => {
    it("agent init writes AGENT.md and points at agent publish; mcp init writes a valid server.json", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchAgent(["init", "Code Reviewer"]);
      const agentMd = readFileSync(join("code-reviewer", "AGENT.md"), "utf8");
      expect(agentMd.startsWith("---\nname: code-reviewer\ndescription: ")).toBe(true);
      expect(agentMd).toMatch(/\n---\n/);
      expect(log.mock.calls.flat().join("\n")).toContain("ahood agent publish <owner>/<agent>@<version> --path code-reviewer");

      await dispatchMcp(["init", "gh"]);
      const manifest = JSON.parse(readFileSync(join("gh", "server.json"), "utf8"));
      expect(manifest.name).toBe("gh");
      expect(manifest.description.length).toBeGreaterThan(0);
      expect(manifest.packages).toBeUndefined();
      expect(manifest.remotes).toEqual([{ url: "https://mcp.example.com/mcp" }]);
      expect(log.mock.calls.flat().join("\n")).toContain("ahood mcp publish <owner>/<server>@<version> --path gh");
    });

    it("refuses to overwrite, to mix kinds in one folder, or to escape the project", async () => {
      quiet();
      await dispatchAgent(["init", "rev"]);
      await expect(dispatchAgent(["init", "rev"])).rejects.toThrow(/AGENT.md already exists/);
      await expect(dispatchMcp(["init", "rev"])).rejects.toThrow(/already an agent/);
      expect(existsSync(join("rev", "server.json"))).toBe(false);
      await expect(dispatchMcp(["init", "../escape"])).rejects.toThrow(/outside the current directory/);
      expect(existsSync(join(dir, "..", "escape"))).toBe(false);
    });

    it("legacy skill init keeps its exact output", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchSkill(["init", "pdf"]);
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        `Created ${join(dir, "pdf", "SKILL.md")}`,
        "Fill in the description, then flesh out the ## Instructions section.",
        "Run `ahood skill publish <owner>/<skill>@<version> --path pdf` when ready.",
      ]);
    });
  });
});
