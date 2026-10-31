// `ahood find` (ahood#1019): the kind-aware front door over search.ts's
// searchSkills -- one GET /api/v1/skills, with the kind and sort the browse
// route honours.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { find } from "../src/commands/find.js";
import { search } from "../src/commands/search.js";

const API_URL = "http://ahood.test";

const ROWS = [
  {
    slug: "paddle-webhooks",
    name: "Paddle webhooks",
    tagline: "Verify and replay Paddle webhooks\u001b[2J",
    kind: "skill",
    downloads_count: 120,
    stars_count: 7,
    profiles: { username: "alice" },
  },
  { slug: "orphan", name: "Orphan", tagline: null, kind: "mcp", downloads_count: 3, profiles: null },
];

describe("ahood find", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  let out: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ skills: ROWS }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  const params = () => new URL(String(fetchMock.mock.calls[0][0])).searchParams;

  it("sends the query, kind, sort and limit to GET /api/v1/skills", async () => {
    await find(["paddle", "webhooks", "--kind", "skill", "--sort", "stars", "--limit", "5"]);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/api/v1/skills");
    expect(Object.fromEntries(params())).toEqual({ q: "paddle webhooks", kind: "skill", sort: "stars", per_page: "5" });
  });

  it("browses with no query when a sort or kind is given (trending), sending no q at all", async () => {
    await find(["--sort", "downloads", "--kind", "mcp"]);
    expect(params().has("q")).toBe(false);
    expect(params().get("sort")).toBe("downloads");
  });

  it("prints owner/slug, kind, purpose, stars and downloads per result, sanitized", async () => {
    await find(["paddle"]);
    expect(out[0]).toBe("alice/paddle-webhooks  [skill]  Verify and replay Paddle webhooks [2J  (7 stars, 120 downloads)");
    expect(out[1]).toBe("(unknown)/orphan  [mcp]  Orphan  (? stars, 3 downloads)");
    expect(out.join("\n")).toContain("ahood try <owner>/<slug>");
  });

  it("--json emits normalized results", async () => {
    await find(["paddle", "--json"]);
    expect(JSON.parse(out[0])).toEqual([
      {
        ref: "alice/paddle-webhooks",
        owner: "alice",
        slug: "paddle-webhooks",
        kind: "skill",
        name: "Paddle webhooks",
        tagline: ROWS[0].tagline,
        stars: 7,
        downloads: 120,
        updated_at: null,
      },
      { ref: "(unknown)/orphan", owner: null, slug: "orphan", kind: "mcp", name: "Orphan", tagline: null, stars: null, downloads: 3, updated_at: null },
    ]);
  });

  it("says so when nothing matches", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    await find(["nothing", "--kind", "loop"]);
    expect(out).toEqual(["No loops found."]);
  });

  it("validates its flags before any request", async () => {
    await expect(find([])).rejects.toThrow(/Usage: ahood find/);
    await expect(find(["x", "--kind", "plugin"])).rejects.toThrow(/--kind must be one of: skill, agent, mcp, doc, project, loop, prompt/);
    await expect(find(["x", "--sort", "trending"])).rejects.toThrow(/--sort must be one of: rank, downloads, stars, recent, updated/);
    await expect(find(["x", "--limit", "0"])).rejects.toThrow(/--limit must be an integer from 1 to 50/);
    await expect(find(["x", "--bogus"])).rejects.toThrow(/Unknown flag: --bogus/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves `ahood skill search`'s request byte-for-byte as it was (no sort, q always sent)", async () => {
    await search(["paddle"]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API_URL}/api/v1/skills?q=paddle`);
  });
});
