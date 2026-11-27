// The --json contract (ahood-cli#251), checked on the built CLI as a real
// subprocess: a spy on console.log cannot see a stray process.stdout.write (a
// masked secret prompt, a confirm() question), and "stdout is exactly one JSON
// document" is a claim about the process's stdout, not about one function.
//
// The success table is keyed against the dispatch maps, so a verb added to
// index.ts without a row here -- or without a reason for having none -- fails
// "covers every command" instead of shipping an unchecked --json.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { COMMANDS, GROUP_VERBS, SKILL_COMMANDS, SNAP_VERBS } from "../src/index.js";
import { CLI_KINDS } from "../src/kinds.js";
import { tarGz } from "./helpers/fake-registry.js";

const cliPath = resolve(__dirname, "..", "dist", "index.js");

const PROMPT_MD = `---
name: demo-prompt
intent: Say hello to someone
inputs:
  - key: who
    label: Who to greet
    default: world
---
Hello {{who}}.
`;

let server: Server;
let apiUrl: string;
let dir: string;
let archive: Buffer;
let checksum: string;
// An mcp-kind entry whose server.json declares one required secret.
let mcpArchive: Buffer;
let mcpChecksum: string;

type Result = { stdout: string; stderr: string; code: number };

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<Result> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: dir,
        env: {
          ...process.env,
          HOME: dir,
          // Without this, a developer's own XDG_CONFIG_HOME would point
          // `logout --json` below at their real stored credentials.
          XDG_CONFIG_HOME: join(dir, "xdg"),
          AHOOD_API_URL: apiUrl,
          AHOOD_TOKEN: "t",
          AHOOD_API_TOKEN: undefined,
          AHOOD_INSTALLED_FILE: join(dir, "installed.json"),
          ...env,
        } as NodeJS.ProcessEnv,
        encoding: "utf8",
      },
      (error, stdout, stderr) => done({ stdout, stderr, code: error ? ((error as { code?: number }).code ?? 1) : 0 }),
    );
    // A closed stdin: anything that tried to prompt would fail, not hang.
    child.stdin?.end();
  });
}

// The whole of stdout must parse as one JSON value -- a second document, a
// prose line before it or a prompt after it all make JSON.parse throw.
function oneDocument(result: Result): unknown {
  expect(result.stdout.endsWith("\n"), `stdout: ${JSON.stringify(result.stdout)} stderr: ${result.stderr}`).toBe(true);
  expect(result.stdout.trimEnd().includes("\n"), `more than one line on stdout: ${result.stdout}`).toBe(false);
  return JSON.parse(result.stdout);
}

const GROUP = { id: "g1", slug: "team", name: "Team", description: null, owner_user_id: "u1", created_at: "2026-01-01T00:00:00Z" };
const SNAP = { id: "s1", content: "note", tags: ["a"], created_at: "2026-01-01T00:00:00Z" };

function detail(slug: string): Record<string, unknown> {
  const prompt = slug === "pr";
  const mcp = slug === "srv";
  return {
    id: "sk1",
    owner: "alice",
    slug,
    name: "Foo",
    kind: prompt ? "prompt" : mcp ? "mcp" : "skill",
    tagline: "A demo",
    tags: [],
    license: null,
    visibility: "public",
    downloads_count: 1,
    stars_count: 0,
    profiles: { username: "alice" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    skill_versions: {
      version: "1.0.0",
      status: "published",
      manifest: [{ path: mcp ? "server.json" : "SKILL.md" }],
      checksum_sha256: mcp ? mcpChecksum : checksum,
      skill_md_content: prompt ? PROMPT_MD : "# demo\n",
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}

type Reply = { status?: number; body: unknown } | Buffer;

function reply(method: string, path: string, auth: string): Reply {
  const notFound: Reply = { status: 404, body: { error: "Not found" } };
  if (path.includes("missing")) return notFound;
  const is = (m: string, re: RegExp) => method === m && re.test(path);
  const skill = "/api/v1/skills/alice/(foo|pr|srv)";
  const slug = path.split("/")[5] ?? "";

  if (path === "/upload") return { body: {} };
  if (is("POST", /^\/api\/mcp$/)) {
    return { body: { result: { content: [{ type: "text", text: JSON.stringify({ project: "github.com/alice/acme", guides: [] }) }] } } };
  }
  if (is("GET", /^\/api\/v1\/profile$/)) {
    if (auth.endsWith("provisioning")) return { status: 404, body: { error: "Not found", provisioning: true } };
    return { body: { username: "alice", display_name: null, bio: null, avatar_url: null, github_username: null } };
  }
  if (is("GET", /^\/api\/v1\/auth\/tokens$/)) {
    if (auth.endsWith("revoked")) return { status: 401, body: { error: "Unauthorized" } };
    if (auth.endsWith("provisioning")) return { status: 403, body: { error: "Session required" } };
    return { body: { tokens: [{ id: "t1", name: "ci", token_prefix: "ahd_ab", scopes: ["read"], revoked_at: null, created_at: "2026-01-01" }] } };
  }
  if (is("POST", /^\/api\/v1\/auth\/tokens$/)) return { body: { id: "t2", name: "ci", token: "ahd_secret" } };
  if (is("DELETE", /^\/api\/v1\/auth\/tokens\/t1$/)) return { body: { revoked: true } };

  if (is("GET", /^\/api\/v1\/skills$/)) return { body: { skills: [detail("foo")], closest: [] } };
  if (is("GET", new RegExp(`^${skill}$`))) return { body: detail(slug) };
  if (is("PATCH", new RegExp(`^${skill}$`))) {
    return { body: { slug: "foo", tagline: "x", license: null, visibility: "private", tags: [], homepage: null, repository: null } };
  }
  if (is("DELETE", new RegExp(`^${skill}$`))) return { body: { deleted: true } };
  if (is("GET", new RegExp(`^${skill}/versions$`))) {
    return { body: { versions: [{ version: "1.0.0", changelog_md: null, package_size_bytes: 10, created_at: "2026-01-01T00:00:00Z" }] } };
  }
  if (is("POST", new RegExp(`^${skill}/versions/init$`))) return { body: { version_id: "v1", upload_url: `${apiUrl}/upload` } };
  if (is("POST", new RegExp(`^${skill}/versions/complete$`))) return { body: { version_id: "v1", version: "1.0.1", status: "processing" } };
  if (is("GET", new RegExp(`^${skill}/versions/[0-9.]+$`))) {
    return {
      body: {
        version: path.split("/").pop(),
        status: "published",
        manifest: [{ path: "SKILL.md" }],
        checksum_sha256: checksum,
        yanked_at: null,
        kind: "skill",
      },
    };
  }
  if (is("DELETE", new RegExp(`^${skill}/versions/[0-9.]+$`))) return { body: { ok: true } };
  if (is("GET", new RegExp(`^${skill}/download$`))) return slug === "srv" ? mcpArchive : archive;
  if (is("POST", new RegExp(`^${skill}/star$`))) return { body: { starred: true } };
  if (is("DELETE", new RegExp(`^${skill}/star$`))) return { body: { starred: false } };
  if (is("POST", new RegExp(`^${skill}/vote$`))) return { body: { value: 1, upvotes: 1, downvotes: 0 } };
  if (is("DELETE", new RegExp(`^${skill}/vote$`))) return { body: { value: 0, upvotes: 0, downvotes: 0 } };
  if (is("POST", new RegExp(`^${skill}/share$`))) return { body: { shared: true } };
  if (is("DELETE", new RegExp(`^${skill}/share/team$`))) return { body: { shared: false } };

  if (is("POST", /^\/api\/v1\/groups$/)) return { body: GROUP };
  if (is("GET", /^\/api\/v1\/groups$/)) return { body: { groups: [GROUP] } };
  if (is("GET", /^\/api\/v1\/groups\/team$/)) {
    return { body: { group: GROUP, members: [{ userId: "u1", username: "alice", avatarUrl: null, role: "owner", joinedAt: "2026-01-01T00:00:00Z" }] } };
  }
  if (is("POST", /^\/api\/v1\/groups\/team\/invites$/)) return { body: { token: "tok", expiresAt: "2027-01-01T00:00:00Z" } };
  if (is("POST", /^\/api\/v1\/groups\/invites\/tok\/accept$/)) return { body: { groupSlug: "team", groupName: "Team" } };
  if (is("DELETE", /^\/api\/v1\/groups\/team\/members\/(bob|alice)$/)) return { body: { removed: true } };
  if (is("DELETE", /^\/api\/v1\/groups\/team$/)) return { body: { deleted: true } };

  if (is("POST", /^\/api\/v1\/snaps$/)) return { body: { id: "s1", created_at: "2026-01-01T00:00:00Z" } };
  if (is("GET", /^\/api\/v1\/snaps$/)) return { body: { snaps: [SNAP], next_cursor: null } };
  if (is("GET", /^\/api\/v1\/snaps\/s1$/)) return { body: SNAP };
  if (is("PATCH", /^\/api\/v1\/snaps\/s1$/)) return { body: { id: "s1", tags: ["b"] } };
  if (is("DELETE", /^\/api\/v1\/snaps\/s1$/)) return { body: { deleted: true } };
  if (is("POST", /^\/api\/v1\/snaps\/s1\/share$/)) return { body: { share_url: "https://ahood.test/s/abc" } };
  if (is("DELETE", /^\/api\/v1\/snaps\/s1\/share$/)) return { body: { shared: false } };

  if (is("POST", /^\/api\/v1\/feedback$/)) return { body: { id: "f1" } };
  if (is("POST", /^\/api\/v1\/me\/status$/)) {
    return {
      body: {
        items: [{ owner: "alice", slug: "foo", installed_version: "1.0.0", status: "ok", kind: "skill", latest_version: "1.0.0", update_available: false, is_owner: false }],
        plan: { evolution_available: false, consented: false },
      },
    };
  }
  if (is("GET", /^\/api\/v1\/me\/proposals$/)) {
    return { body: { total: 1, items: [{ candidate_id: "p1", owner: "alice", artifact: { id: "sk1", slug: "foo" }, created_at: "2026-01-01T00:00:00Z" }], next_cursor: null } };
  }
  if (is("POST", /^\/api\/v1\/me\/proposals\/p1\/approve$/)) return { body: { status: "promoting", versionId: "v2" } };
  if (is("POST", /^\/api\/v1\/me\/proposals\/p1\/reject$/)) return { body: { status: "rejected" } };
  if (is("GET", /^\/api\/v1\/enhancements\/candidates\/p1\/diff$/)) return { body: { files: [], unchanged_binaries: [], truncated: false } };
  if (is("GET", /^\/api\/v1\/enhancements\/summary$/)) return { body: {} };
  if (is("GET", /^\/api\/v1\/users\/alice\/activity$/)) return { body: { entries: [] } };
  return notFound;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ahood-cli-json-"));
  archive = await tarGz({ "SKILL.md": "---\nname: foo\ndescription: A demo skill for the json contract test.\n---\nbody\n" });
  checksum = createHash("sha256").update(archive).digest("hex");
  mcpArchive = await tarGz({
    "server.json": JSON.stringify({
      name: "srv",
      description: "d",
      packages: [
        {
          registry_type: "npm",
          identifier: "@demo/srv",
          version: "1.0.0",
          runtime_hint: "npx",
          environment_variables: [{ name: "DEMO_SRV_KEY", description: "API key", is_required: true, is_secret: true }],
        },
      ],
    }),
  });
  mcpChecksum = createHash("sha256").update(mcpArchive).digest("hex");
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const out = reply(req.method ?? "GET", path, String(req.headers.authorization ?? ""));
      if (Buffer.isBuffer(out)) {
        res.setHeader("Content-Type", "application/gzip");
        res.end(out);
        return;
      }
      res.statusCode = out.status ?? 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

// One row per --json invocation. `before` runs first (plain commands that set
// up local state: an install to remove, a folder to publish). `keys` are keys
// the document must carry; `code` defaults to 0.
type Row = { args: string[]; before?: string[][]; keys?: string[]; code?: number | "any" };

const ADD = ["skill", "add", "alice/foo"];

const TOP: Record<string, Row[]> = {
  logout: [{ args: ["logout"], keys: ["logged_out"] }],
  whoami: [{ args: ["whoami"], keys: ["authenticated", "mode", "username"] }],
  token: [
    { args: ["token", "create", "ci"], keys: ["name", "token"] },
    { args: ["token", "list"] },
    { args: ["token", "revoke", "t1", "--yes"], keys: ["id", "revoked"] },
  ],
  status: [{ args: ["status"], before: [ADD], keys: ["items", "plan"] }],
  sync: [{ args: ["sync", "--dry-run"], before: [ADD], keys: ["results"] }],
  pin: [{ args: ["pin", "alice/foo"], before: [ADD], keys: ["owner", "slug", "installs"] }],
  unpin: [{ args: ["unpin", "alice/foo"], before: [ADD, ["pin", "alice/foo"]], keys: ["owner", "slug", "unpinned"] }],
  review: [
    { args: ["review"], keys: ["items"] },
    { args: ["review", "show", "p1"], keys: ["candidate_id", "diff"] },
    { args: ["review", "approve", "p1"], keys: ["id", "status"] },
    { args: ["review", "reject", "p1"], keys: ["id", "status"] },
  ],
  find: [{ args: ["find", "pdf"] }],
  try: [{ args: ["try", "alice/foo"], keys: ["version", "content", "provenance"] }],
  stats: [{ args: ["stats"], keys: ["owner", "totals"] }],
  feedback: [{ args: ["feedback", "works well", "--kind", "praise"], keys: ["id", "kind", "sent"] }],
  // Harness detection decides doctor's exit code; only the document is checked.
  doctor: [{ args: ["doctor", "--offline"], code: "any" }],
  project: [{ args: ["project", "--remote", "github.com/alice/acme"], keys: ["project", "guides"] }],
  prompt: [{ args: ["prompt", "get", "alice/pr"], keys: ["owner", "slug", "text"] }],
};

const SKILL: Record<string, Row[]> = {
  search: [{ args: ["skill", "search", "pdf"] }],
  view: [{ args: ["skill", "view", "alice/foo"], keys: ["owner", "slug"] }],
  show: [{ args: ["skill", "show", "alice/foo"], keys: ["owner", "slug"] }],
  read: [{ args: ["skill", "read", "alice/foo"], keys: ["version", "content", "provenance"] }],
  versions: [{ args: ["skill", "versions", "alice/foo"] }],
  diff: [{ args: ["skill", "diff", "alice/foo", "1.0.0", "1.0.1"], keys: ["skillmd_diff", "manifest"] }],
  list: [{ args: ["skill", "list"] }],
  add: [{ args: ADD, keys: ["owner", "skill", "version", "kind", "installed_path"] }],
  update: [{ args: ["skill", "update", "--dry-run"], before: [ADD] }],
  outdated: [{ args: ["skill", "outdated"], before: [ADD] }],
  remove: [{ args: ["skill", "remove", "alice/foo", "--yes"], before: [ADD], keys: ["owner", "skill", "removed", "mcp_entry"] }],
  edit: [{ args: ["skill", "edit", "alice/foo", "--tagline", "x"], keys: ["owner", "skill", "slug", "tagline", "visibility", "tags"] }],
  unpublish: [
    { args: ["skill", "unpublish", "alice/foo", "--yes"], keys: ["owner", "skill", "unpublished"] },
    { args: ["skill", "unpublish", "alice/foo@1.0.0", "--yes"], keys: ["owner", "skill", "version", "yanked"] },
  ],
  star: [{ args: ["skill", "star", "alice/foo"], keys: ["owner", "skill", "starred"] }],
  unstar: [{ args: ["skill", "unstar", "alice/foo"], keys: ["owner", "skill", "starred"] }],
  vote: [{ args: ["skill", "vote", "alice/foo", "up"], keys: ["value", "upvotes", "downvotes"] }],
  share: [{ args: ["skill", "share", "alice/foo", "--group", "team"], keys: ["owner", "skill", "group", "shared"] }],
  unshare: [{ args: ["skill", "unshare", "alice/foo", "--group", "team"], keys: ["owner", "skill", "group", "shared"] }],
  init: [{ args: ["skill", "init", "scaffolded"], keys: ["kind", "name", "path"] }],
  publish: [
    { args: ["skill", "publish", "alice/foo@1.0.1", "--path", "to-publish"], before: [["skill", "init", "to-publish"]], keys: ["version", "status"] },
  ],
};

const GROUPS: Record<string, Row[]> = {
  create: [{ args: ["group", "create", "Team"], keys: ["id", "slug", "name"] }],
  list: [{ args: ["group", "list"] }],
  members: [{ args: ["group", "members", "team"], keys: ["group", "members"] }],
  "invite-link": [{ args: ["group", "invite-link", "team"], keys: ["token", "expires_at", "url"] }],
  join: [{ args: ["group", "join", "tok"], keys: ["joined", "slug", "name"] }],
  "remove-member": [{ args: ["group", "remove-member", "team", "bob", "--yes"], keys: ["removed", "slug", "username"] }],
  leave: [{ args: ["group", "leave", "team", "--yes"], keys: ["left", "slug", "username"] }],
  delete: [{ args: ["group", "delete", "team", "--yes"], keys: ["deleted", "slug"] }],
};

const SNAPS: Record<string, Row[]> = {
  create: [{ args: ["snap", "create", "a note"], keys: ["id", "created_at"] }],
  list: [{ args: ["snap", "list"] }],
  search: [{ args: ["snap", "search", "note"] }],
  show: [{ args: ["snap", "show", "s1"], keys: ["id", "content"] }],
  remove: [{ args: ["snap", "remove", "s1", "--yes"], keys: ["id", "deleted"] }],
  share: [{ args: ["snap", "share", "s1"], keys: ["share_url"] }],
  unshare: [{ args: ["snap", "unshare", "s1", "--yes"], keys: ["id", "shared"] }],
  tags: [
    { args: ["snap", "tags", "s1"], keys: ["id", "tags"] },
    { args: ["snap", "tags", "s1", "b"], keys: ["id", "tags"] },
  ],
};

// Top-level commands with no --json document, and why. Everything else in
// COMMANDS must have a row in TOP (or be a noun covered by SKILL/GROUPS/SNAPS).
const NO_JSON: Record<string, string> = {
  login: "interactive device-code flow; refuses --json (asserted below)",
  completion: "prints a shell script, which is the output",
  setup: "interactive harness wiring; has its own --dry-run report",
};
const NOUNS = new Set<string>([...CLI_KINDS, "group", "snap"]);

describe("--json: stdout is exactly one JSON document on success", () => {
  it("covers every command in the dispatch maps", () => {
    const top = Object.keys(COMMANDS).filter((c) => !NOUNS.has(c) || c === "project" || c === "prompt");
    expect([...Object.keys(TOP), ...Object.keys(NO_JSON)].sort()).toEqual(top.sort());
    expect(Object.keys(SKILL).sort()).toEqual(Object.keys(SKILL_COMMANDS).sort());
    expect(Object.keys(GROUPS).sort()).toEqual(Object.keys(GROUP_VERBS).sort());
    expect(Object.keys(SNAPS).sort()).toEqual(Object.keys(SNAP_VERBS).sort());
  });

  const rows = [TOP, SKILL, GROUPS, SNAPS].flatMap((table) => Object.values(table).flat());
  it.each(rows.map((row) => [row.args.join(" "), row] as const))("ahood %s --json", async (_name, row) => {
    for (const setup of row.before ?? []) {
      const prepared = await run(setup);
      expect(prepared.code, `setup "${setup.join(" ")}" failed: ${prepared.stderr}`).toBe(0);
    }
    const result = await run([...row.args, "--json"]);
    if (row.code !== "any") expect(result.code, result.stderr).toBe(row.code ?? 0);
    const doc = oneDocument(result);
    expect(doc).not.toBeNull();
    expect(typeof doc).toBe("object");
    for (const key of row.keys ?? []) expect(doc).toHaveProperty(key);
    // A success document is never mistaken for the failure one.
    if (row.code !== "any") expect(doc).not.toHaveProperty("error");
  });
});

describe("--json: one error convention", () => {
  // stdout {error, exit_code}; stderr keeps the human message; the exit code
  // is the documented one and matches exit_code.
  async function expectFailure(args: string[], code: number, message: RegExp, env: Record<string, string | undefined> = {}) {
    const result = await run(args, env);
    expect(result.code, result.stderr).toBe(code);
    const doc = oneDocument(result) as { error: string; exit_code: number };
    expect(doc.exit_code).toBe(code);
    expect(doc.error).toMatch(message);
    expect(result.stderr).toMatch(message);
    return doc as Record<string, unknown>;
  }

  it("a 404 on a read command", async () => {
    const doc = await expectFailure(["skill", "view", "alice/missing", "--json"], 5, /not found/i);
    expect(Object.keys(doc).sort()).toEqual(["error", "exit_code"]);
  });

  it("a 404 on a write command", async () => {
    const doc = await expectFailure(["skill", "star", "alice/missing", "--json"], 5, /not found/i);
    expect(Object.keys(doc).sort()).toEqual(["error", "exit_code"]);
  });

  it("publish no longer has an error shape of its own", async () => {
    await run(["skill", "init", "unpublishable"]);
    const doc = await expectFailure(["skill", "publish", "alice/missing@1.0.0", "--path", "unpublishable", "--json"], 1, /pass --name/);
    expect(Object.keys(doc).sort()).toEqual(["error", "exit_code"]);
  });

  it("a usage error, before any request", async () => {
    await expectFailure(["skill", "star", "--json"], 2, /Usage: ahood skill star/);
  });

  it("an unknown command and an unknown verb", async () => {
    await expectFailure(["nope", "--json"], 2, /Unknown command: nope/);
    await expectFailure(["group", "nope", "--json"], 2, /Unknown group command: nope/);
  });

  it("a locally reported failure (remove of something not installed)", async () => {
    await expectFailure(["skill", "remove", "alice/never-installed", "--yes", "--json"], 1, /was not installed/);
  });

  it("whoami keeps its own fields and adds the convention's", async () => {
    const revoked = await expectFailure(["whoami", "--json"], 4, /invalid or has been revoked/, { AHOOD_TOKEN: "revoked" });
    expect(revoked).toMatchObject({ authenticated: false, reason: "invalid_token" });
    const loggedOut = await expectFailure(["whoami", "--json"], 4, /Not logged in/, { AHOOD_TOKEN: undefined });
    expect(loggedOut).toMatchObject({ authenticated: false });
  });

  it("without --json a failure leaves stdout empty, as before", async () => {
    const result = await run(["skill", "view", "alice/missing"]);
    expect(result.code).toBe(5);
    expect(result.stdout).toBe("");
  });
});

describe("--json never prompts", () => {
  it.each([
    [["skill", "remove", "alice/foo"]],
    [["skill", "unpublish", "alice/foo"]],
    [["group", "delete", "team"]],
    [["group", "leave", "team"]],
    [["group", "remove-member", "team", "bob"]],
    [["snap", "remove", "s1"]],
    [["snap", "unshare", "s1"]],
    [["token", "revoke", "t1"]],
  ])("ahood %j --json without --yes is refused (exit 2), not asked", async (args) => {
    const result = await run([...args, "--json"]);
    expect(result.code).toBe(2);
    expect((oneDocument(result) as { error: string }).error).toMatch(/needs --yes/);
  });

  // promptSecret writes its prompt and masking to stdout; under --json an
  // unresolved secret is an error naming the variable, never a question.
  it("mcp add --json fails on an unset required secret, and writes nothing", async () => {
    const result = await run(["mcp", "add", "alice/srv", "--json"], { DEMO_SRV_KEY: undefined });
    expect(result.code).toBe(1);
    const doc = oneDocument(result) as { error: string; exit_code: number };
    expect(doc.error).toMatch(/DEMO_SRV_KEY is required .* --json never prompts/);
    expect(doc.exit_code).toBe(1);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("mcp add --json takes the secret from the environment, with the secrets warning on stderr only", async () => {
    const result = await run(["mcp", "add", "alice/srv", "--json"], { DEMO_SRV_KEY: "s3cret" });
    expect(result.code, result.stderr).toBe(0);
    expect(oneDocument(result)).toEqual({
      owner: "alice",
      skill: "srv",
      version: "1.0.0",
      kind: "mcp",
      installed_path: join(dir, ".mcp.json"),
    });
    expect(result.stdout).not.toContain("s3cret");
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.srv.env).toEqual({ DEMO_SRV_KEY: "s3cret" });
    const removed = await run(["mcp", "remove", "alice/srv", "--yes", "--json"]);
    expect(oneDocument(removed)).toEqual({ owner: "alice", skill: "srv", removed: true, mcp_entry: "removed" });
  });

  it("login refuses --json instead of starting a device-code flow", async () => {
    const result = await run(["login", "--json"]);
    expect(result.code).toBe(2);
    expect((oneDocument(result) as { error: string }).error).toMatch(/has no --json output/);
  });
});

describe("--json: snake_case keys, camelCase kept as deprecated aliases", () => {
  it("group invite-link: expires_at, with expiresAt still there", async () => {
    const doc = oneDocument(await run(["group", "invite-link", "team", "--json"])) as Record<string, unknown>;
    expect(doc.expires_at).toBe("2027-01-01T00:00:00Z");
    expect(doc.expiresAt).toBe(doc.expires_at);
  });

  it("whoami: profile_status, with profileStatus still there", async () => {
    const result = await run(["whoami", "--json"], { AHOOD_TOKEN: "provisioning" });
    expect(result.code).toBe(0);
    const doc = oneDocument(result) as Record<string, unknown>;
    expect(doc.profile_status).toBe("provisioning");
    expect(doc.profileStatus).toBe("provisioning");
  });

  it("group members: user_id/avatar_url/joined_at next to the camelCase keys", async () => {
    const doc = oneDocument(await run(["group", "members", "team", "--json"])) as { members: Array<Record<string, unknown>> };
    expect(doc.members[0]).toMatchObject({ user_id: "u1", userId: "u1", avatar_url: null, joined_at: "2026-01-01T00:00:00Z", joinedAt: "2026-01-01T00:00:00Z" });
  });
});
