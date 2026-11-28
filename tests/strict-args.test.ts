import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, GROUP_VERBS, SKILL_COMMANDS, SNAP_VERBS } from "../src/index.js";
import { parseArgs, YES_FLAGS } from "../src/flags.js";
import { UsageError } from "../src/usage-error.js";

// ahood-cli#260: every handler refuses what it does not declare, and refuses
// it BEFORE the first request or write. The tables below are keyed by the
// dispatch maps themselves, so a verb added to index.ts without a row here
// fails "covers every verb" instead of shipping unchecked.

type Handler = (args: string[]) => Promise<void>;

// A valid invocation of each verb -- valid enough that, without the unknown
// flag appended, the handler would go on to the network or the filesystem.
const SKILL_VALID: Record<string, string[]> = {
  search: ["pdf"],
  view: ["alice/foo"],
  show: ["alice/foo"],
  read: ["alice/foo"],
  versions: ["alice/foo"],
  diff: ["alice/foo", "1.0.0", "1.0.1"],
  list: [],
  add: ["alice/foo"],
  update: [],
  outdated: [],
  remove: ["alice/foo"],
  edit: ["alice/foo", "--tagline", "x"],
  unpublish: ["alice/foo", "--yes"],
  star: ["alice/foo"],
  unstar: ["alice/foo"],
  vote: ["alice/foo", "up"],
  share: ["alice/foo", "--group", "team"],
  unshare: ["alice/foo", "--group", "team"],
  init: ["my-skill"],
  publish: ["alice/foo@1.0.0"],
};

const GROUP_VALID: Record<string, string[]> = {
  create: ["team"],
  list: [],
  members: ["team"],
  "invite-link": ["team"],
  join: ["tok123"],
  "remove-member": ["team", "bob", "--yes"],
  leave: ["team", "--yes"],
  delete: ["team", "--yes"],
};

const SNAP_VALID: Record<string, string[]> = {
  create: ["a note"],
  list: [],
  search: ["query"],
  show: ["snap_1"],
  remove: ["snap_1", "--yes"],
  share: ["snap_1"],
  unshare: ["snap_1", "--yes"],
  tags: ["snap_1"],
};

// Top-level commands that are handlers themselves. The rest of COMMANDS are
// noun dispatchers, whose verbs are the three tables above.
const DISPATCHERS = new Set(["mcp", "skill", "agent", "doc", "project", "loop", "prompt", "group", "snap"]);
const TOP_VALID: Record<string, string[][]> = {
  login: [[]],
  logout: [[]],
  whoami: [[]],
  token: [["create", "ci"], ["list"], ["revoke", "tok_1", "--yes"]],
  completion: [["bash"]],
  status: [[]],
  sync: [[]],
  pin: [["alice/foo"]],
  unpin: [["alice/foo"]],
  review: [[], ["show", "p_1"], ["approve", "p_1"], ["reject", "p_1"]],
  find: [["pdf"]],
  try: [["alice/foo"]],
  stats: [[]],
  feedback: [["it broke"]],
  setup: [[]],
  doctor: [[]],
};

// Free-text verbs: their positionals are a query, a note, a message or tags, so
// a single-dash word is content there, not a flag. "--" tokens are still
// refused (the --bogus table below covers them).
const FREE_TEXT = new Set(["skill search", "snap search", "snap create", "snap tags", "feedback"]);

type Case = { label: string; run: Handler; args: string[] };

function cases(): Case[] {
  const out: Case[] = [];
  for (const [verb, args] of Object.entries(SKILL_VALID)) {
    out.push({ label: `skill ${verb}`, run: SKILL_COMMANDS[verb] as Handler, args });
  }
  for (const [verb, args] of Object.entries(GROUP_VALID)) out.push({ label: `group ${verb}`, run: GROUP_VERBS[verb], args });
  for (const [verb, args] of Object.entries(SNAP_VALID)) out.push({ label: `snap ${verb}`, run: SNAP_VERBS[verb], args });
  for (const [command, variants] of Object.entries(TOP_VALID)) {
    for (const args of variants) out.push({ label: variants.length > 1 ? `${command} ${args[0]}` : command, run: COMMANDS[command], args });
  }
  return out;
}

describe("strict argument parsing (ahood-cli#260)", () => {
  const saved = { ...process.env };
  const originalCwd = process.cwd();
  let dir: string;
  let configHome: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  function respondWith(body: unknown = {}) {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }

  function requests(): { method: string; url: string; body: unknown }[] {
    return fetchMock.mock.calls.map(([input, init]) => ({
      method: (init as RequestInit | undefined)?.method ?? "GET",
      url: String(input),
      body: (init as RequestInit | undefined)?.body ? JSON.parse(String((init as RequestInit).body)) : undefined,
    }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-strict-args-"));
    configHome = mkdtempSync(join(tmpdir(), "ahood-strict-args-config-"));
    process.chdir(dir);
    process.env.AHOOD_API_URL = "http://ahood.test";
    process.env.AHOOD_TOKEN = "tok_test";
    process.env.XDG_CONFIG_HOME = configHome;
    fetchMock = vi.fn(async () => {
      throw new Error("no request expected");
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
    for (const key of ["AHOOD_API_URL", "AHOOD_TOKEN", "XDG_CONFIG_HOME"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    process.exitCode = undefined;
  });

  it("covers every verb in the dispatch maps", () => {
    expect(Object.keys(SKILL_VALID).sort()).toEqual(Object.keys(SKILL_COMMANDS).sort());
    expect(Object.keys(GROUP_VALID).sort()).toEqual(Object.keys(GROUP_VERBS).sort());
    expect(Object.keys(SNAP_VALID).sort()).toEqual(Object.keys(SNAP_VERBS).sort());
    expect(Object.keys(TOP_VALID).sort()).toEqual(
      Object.keys(COMMANDS)
        .filter((c) => !DISPATCHERS.has(c))
        .sort(),
    );
  });

  describe.each(cases())("$label", ({ label, run, args }) => {
    it("refuses an unknown --flag with a UsageError, before any request or write", async () => {
      await expect(run([...args, "--bogus"])).rejects.toBeInstanceOf(UsageError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual([]);
    });

    it.skipIf(FREE_TEXT.has(label))("refuses an unknown single-dash flag the same way", async () => {
      await expect(run([...args, "-x"])).rejects.toBeInstanceOf(UsageError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  describe("the reproductions from the issue", () => {
    it("unpublish --dry-run --yes sends no DELETE", async () => {
      respondWith({ deleted: true });
      await expect(SKILL_COMMANDS.unpublish(["alice/foo", "--dry-run", "--yes"])).rejects.toThrow(/Unknown flag: --dry-run/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["group delete", () => GROUP_VERBS.delete(["team", "--dry-run", "--yes"])],
      ["snap remove", () => SNAP_VERBS.remove(["snap_1", "--dry-run", "--yes"])],
      ["token revoke", () => COMMANDS.token(["revoke", "tok_1", "--dry-run", "--yes"])],
    ])("%s --dry-run --yes sends no DELETE", async (_name, run) => {
      respondWith({});
      await expect(run()).rejects.toBeInstanceOf(UsageError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("edit refuses a misspelled --visiblity instead of dropping it", async () => {
      respondWith({});
      await expect(SKILL_COMMANDS.edit(["alice/foo", "--tagline", "x", "--visiblity", "public"])).rejects.toThrow(
        /Unknown flag: --visiblity/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("publish refuses a misspelled --visiblity instead of publishing private", async () => {
      await expect(SKILL_COMMANDS.publish(["alice/foo@1.0.0", "--visiblity", "public"])).rejects.toThrow(
        /Unknown flag: --visiblity/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["add", ["alice/foo", "bob/bar"]],
      ["versions", ["alice/foo", "bob/bar"]],
    ])("%s refuses a second spec instead of dropping it", async (verb, args) => {
      await expect(SKILL_COMMANDS[verb](args)).rejects.toThrow(/Unexpected extra argument: bob\/bar/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("update refuses an unknown flag instead of treating it as a target", async () => {
      await expect(SKILL_COMMANDS.update(["--yes"])).rejects.toThrow(/Unknown flag: --yes/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("token create --json does not create a token named --json", async () => {
      respondWith({ token: "ahd_x", name: "ci" });
      await expect(COMMANDS.token(["create", "--json"])).rejects.toBeInstanceOf(UsageError);
      expect(fetchMock).not.toHaveBeenCalled();

      await COMMANDS.token(["create", "ci", "--json"]);
      expect(requests()).toEqual([{ method: "POST", url: "http://ahood.test/api/v1/auth/tokens", body: { name: "ci" } }]);
    });

    it("logout --bogus keeps the stored credentials", async () => {
      const credentials = join(configHome, "ahood", "credentials.json");
      mkdirSync(join(configHome, "ahood"), { recursive: true });
      writeFileSync(credentials, JSON.stringify({ token: "tok_stored" }));

      await expect(COMMANDS.logout(["--bogus"])).rejects.toBeInstanceOf(UsageError);
      expect(existsSync(credentials)).toBe(true);

      await COMMANDS.logout([]);
      expect(existsSync(credentials)).toBe(false);
    });

    it("skill init refuses --project, which only `project init` takes", async () => {
      await expect(SKILL_COMMANDS.init(["my-skill", "--project", "github.com/a/b"])).rejects.toThrow(/Unknown flag: --project/);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  describe("flag order and -y", () => {
    function installSkill() {
      const skillPath = join(dir, ".claude", "skills", "alice@foo");
      mkdirSync(skillPath, { recursive: true });
      writeFileSync(join(skillPath, "SKILL.md"), "# foo\n");
      return skillPath;
    }

    it.each([
      ["--yes before the spec", ["--yes", "alice/foo"]],
      ["-y after the spec", ["alice/foo", "-y"]],
    ])("remove works with %s", async (_name, args) => {
      const skillPath = installSkill();
      await SKILL_COMMANDS.remove(args);
      expect(existsSync(skillPath)).toBe(false);
    });

    it.each([
      ["unpublish", () => SKILL_COMMANDS.unpublish(["-y", "alice/foo"]), "/api/v1/skills/alice/foo"],
      ["group delete", () => GROUP_VERBS.delete(["team", "-y"]), "/api/v1/groups/team"],
      ["group remove-member", () => GROUP_VERBS["remove-member"](["team", "-y", "bob"]), "/api/v1/groups/team/members/bob"],
      ["snap remove", () => SNAP_VERBS.remove(["snap_1", "-y"]), "/api/v1/snaps/snap_1"],
      ["snap unshare", () => SNAP_VERBS.unshare(["-y", "snap_1"]), "/api/v1/snaps/snap_1/share"],
      ["token revoke", () => COMMANDS.token(["revoke", "tok_1", "-y"]), "/api/v1/auth/tokens/tok_1"],
    ])("%s takes -y as --yes: one DELETE, no prompt", async (_name, run, path) => {
      respondWith({});
      await run();
      expect(requests()).toEqual([{ method: "DELETE", url: `http://ahood.test${path}`, body: undefined }]);
    });

    it("group leave takes -y as --yes", async () => {
      respondWith({ username: "me" });
      await GROUP_VERBS.leave(["team", "-y"]);
      expect(requests().map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET http://ahood.test/api/v1/profile",
        "DELETE http://ahood.test/api/v1/groups/team/members/me",
      ]);
    });

    it("share takes --group before the spec", async () => {
      respondWith({ shared: true });
      await SKILL_COMMANDS.share(["--group", "team", "alice/foo"]);
      expect(requests()[0]).toMatchObject({ method: "POST", body: { group_slug: "team" } });
    });

    it("a write verb still accepts --json it does not implement yet (ahood-cli#251)", async () => {
      respondWith({ deleted: true });
      await SKILL_COMMANDS.unpublish(["alice/foo", "--yes", "--json"]);
      expect(requests().map((r) => r.method)).toEqual(["DELETE"]);
    });

    it("group join accepts a raw invite token that starts with a dash", async () => {
      respondWith({ groupSlug: "team", groupName: "Team" });
      await GROUP_VERBS.join(["-Ab_c9"]);
      expect(requests()[0].url).toBe("http://ahood.test/api/v1/groups/invites/-Ab_c9/accept");
    });
  });

  describe("parseArgs", () => {
    const usage = "Usage: demo <x> [--yes] [--note <text>]";

    it("returns positionals, booleans and values whatever their order", () => {
      const parsed = parseArgs(["--note", "hi", "a", "--yes", "b"], { usage, booleans: YES_FLAGS, values: ["--note"] });
      expect(parsed.positionals).toEqual(["a", "b"]);
      expect(parsed.has(...YES_FLAGS)).toBe(true);
      expect(parsed.value("--note")).toBe("hi");
    });

    it("does not read a value flag's value as a boolean flag", () => {
      const parsed = parseArgs(["a", "--note", "-y"], { usage, booleans: YES_FLAGS, values: ["--note"] });
      expect(parsed.has(...YES_FLAGS)).toBe(false);
      expect(parsed.value("--note")).toBe("-y");
    });

    it("treats everything after a bare -- as positional", () => {
      const parsed = parseArgs(["--yes", "--", "--weird", "-x"], { usage, booleans: YES_FLAGS });
      expect(parsed.positionals).toEqual(["--weird", "-x"]);
      expect(parsed.has("--yes")).toBe(true);
    });

    it("enforces min and max", () => {
      expect(() => parseArgs([], { usage, min: 1 })).toThrow(usage);
      expect(() => parseArgs(["a", "b"], { usage, max: 1 })).toThrow(/Unexpected extra argument: b/);
    });

    it("keeps flagValue's own errors", () => {
      expect(() => parseArgs(["a", "--note"], { usage, values: ["--note"] })).toThrow(/--note requires a value/);
      expect(() => parseArgs(["--note", "x", "--note", "y"], { usage, values: ["--note"] })).toThrow(/more than once/);
    });

    it("refuses a single-dash token unless dashIsPositional", () => {
      expect(() => parseArgs(["-x"], { usage })).toThrow(/Unknown flag: -x/);
      expect(parseArgs(["-x"], { usage, dashIsPositional: true }).positionals).toEqual(["-x"]);
      expect(() => parseArgs(["--x"], { usage, dashIsPositional: true })).toThrow(/Unknown flag: --x/);
    });
  });
});
