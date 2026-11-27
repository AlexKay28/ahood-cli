import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { view } from "../src/commands/view.js";
import { search } from "../src/commands/search.js";
import { listSkills } from "../src/commands/list.js";
import { versions } from "../src/commands/versions.js";
import { update } from "../src/commands/update.js";
import { listGroups, groupMembers } from "../src/commands/group.js";
import { writeLockfileEntry } from "../src/lockfile.js";

// ahood-cli#253: publisher-authored text must not reach a terminal with its
// control bytes intact (same threat class as #122/#127/#133). Line-clear,
// carriage return, BEL and an OSC 8 hyperlink cover repaint, overwrite and
// hidden-link spoofing.
const EVIL = "t\x1b[2K\rINJECTED\x07\x1b]8;;http://evil.example\x07click\x1b]8;;\x07";
const API_URL = "http://ahood.test";

function stubJson(routes: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(routes(String(input))), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
}

function capture() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

function expectClean(lines: string[]) {
  const out = lines.join("\n");
  expect(out.length).toBeGreaterThan(0);
  expect(out).not.toMatch(/[\x1b\r\x07]/);
  expect(out).toContain("INJECTED"); // sanitized, not dropped
}

describe("publisher text is sanitized in human output (#253)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  let dir: string;
  let originalCwd: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-253-"));
    process.chdir(dir);
    process.env.HOME = dir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  const detail = {
    owner: "alice",
    slug: "demo",
    name: EVIL,
    tagline: EVIL,
    tags: [EVIL],
    license: EVIL,
    visibility: "public",
    homepage: EVIL,
    repository: EVIL,
    downloads_count: 1,
    stars_count: 1,
    created_at: "2025-01-01",
    updated_at: "2025-01-02",
    is_starred: null,
    skill_versions: { version: "1.0.0", yanked_at: "2025-01-01", yanked_reason: EVIL },
  };

  it("view: name, tagline, tags, homepage, yanked_reason; --json stays raw", async () => {
    stubJson(() => detail);
    const lines = capture();
    await view(["alice/demo"]);
    expectClean(lines);

    vi.restoreAllMocks();
    const json = capture();
    await view(["alice/demo", "--json"]);
    expect(json[0]).toBe(JSON.stringify(detail));
  });

  const row = { slug: "demo", name: EVIL, tagline: EVIL, downloads_count: 1, stars_count: 1, visibility: "public", profiles: { username: "alice" } };

  it("search: formatRow fields; --json stays raw", async () => {
    stubJson(() => ({ skills: [row] }));
    const lines = capture();
    await search(["demo"]);
    expectClean(lines);

    vi.restoreAllMocks();
    const json = capture();
    await search(["demo", "--json"]);
    expect(json[0]).toBe(JSON.stringify([row]));
  });

  it("list: name and tagline; --json stays raw", async () => {
    stubJson(() => ({ skills: [row] }));
    const lines = capture();
    await listSkills([]);
    expectClean(lines);

    vi.restoreAllMocks();
    const json = capture();
    await listSkills(["--json"]);
    expect(json[0]).toBe(JSON.stringify([row]));
  });

  it("versions: changelog and yanked_reason; --json stays raw", async () => {
    const v = { version: "1.0.0", created_at: "2025-01-01", package_size_bytes: 10, changelog_md: `fix\n${EVIL}`, yanked_at: "2025-01-02", yanked_reason: EVIL };
    stubJson(() => ({ versions: [v] }));
    const lines = capture();
    await versions(["alice/demo"]);
    expectClean(lines);

    vi.restoreAllMocks();
    const json = capture();
    await versions(["alice/demo", "--json"]);
    expect(json[0]).toBe(JSON.stringify([v]));
  });

  it("update --dry-run: changelog_md keeps newlines but loses control bytes; --json stays raw", async () => {
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/behind", { version: "1.0.0", checksum_sha256: "old" });
    const meta = { skill_versions: { version: "2.0.0", manifest: [{ path: "SKILL.md" }], checksum_sha256: "new", changelog_md: `fixes\n${EVIL}` } };
    stubJson(() => meta);
    const lines = capture();
    await update(["--dry-run"]);
    expectClean(lines);
    expect(lines.join("\n")).toContain("fixes\nt ");

    vi.restoreAllMocks();
    const json = capture();
    await update(["--dry-run", "--json"]);
    // JSON.stringify escapes the bytes, so the raw text round-trips unchanged.
    expect(json.join("\n")).toContain("\\u001b[2K");
  });

  it("group list / members: name, description, member names; --json stays raw", async () => {
    const g = { slug: "team", name: EVIL, description: EVIL };
    stubJson(() => ({ groups: [g] }));
    const lines = capture();
    await listGroups([]);
    expectClean(lines);

    vi.restoreAllMocks();
    stubJson(() => ({ group: g, members: [{ username: EVIL, role: EVIL }] }));
    const mlines = capture();
    await groupMembers(["team"]);
    expectClean(mlines);

    vi.restoreAllMocks();
    const json = capture();
    await groupMembers(["team", "--json"]);
    expect(json[0]).toBe(JSON.stringify({ group: g, members: [{ username: EVIL, role: EVIL }] }));
  });
});
