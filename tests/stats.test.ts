// `ahood stats` (ahood#1019) and `ahood try`: the caller's own numbers, and the
// read-without-installing alias the /ahood-try and /ahood-loop commands call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stats, EVOLUTION_DASHBOARD_NOTE } from "../src/commands/stats.js";
import { COMMANDS } from "../src/index.js";
import { findCommandHelp } from "../src/help.js";

const API_URL = "http://ahood.test";

const MINE = [
  { slug: "small", name: "Small", tagline: null, visibility: "private", kind: "loop", downloads_count: 2, stars_count: 0, profiles: { username: "me" } },
  { slug: "big", name: "Big", tagline: null, visibility: "public", kind: "skill", downloads_count: 40, stars_count: 5, profiles: { username: "me" } },
];
const ACTIVITY = {
  entries: [{ id: 1, createdAt: "2026-10-30T09:00:00.000Z", text: "Published me/big 1.2.0\u001b]0;x\u0007", href: "/me/big", category: "publish" }],
};

type Route = (path: string) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ahood stats", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  let out: string[];
  let paths: string[];

  function serve(override: Route = () => undefined) {
    paths = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        const path = u.pathname + u.search;
        paths.push(path);
        const custom = override(path);
        if (custom) return custom;
        if (path === "/api/v1/profile") return json({ username: "me" });
        if (path === "/api/v1/skills?mine=true") return json({ skills: MINE });
        if (path === "/api/v1/users/me/activity") return json(ACTIVITY);
        if (path === "/api/v1/enhancements/summary") return json({ evolving_count: 1, candidates_waiting: 2 });
        return json({ error: "Not found" }, 404);
      }),
    );
  }

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("--json: own artifacts by downloads, totals, activity and evolution counts -- never the session-only analytics route", async () => {
    serve();
    await stats(["--json"]);
    expect(paths).toEqual(["/api/v1/profile", "/api/v1/skills?mine=true", "/api/v1/users/me/activity", "/api/v1/enhancements/summary"]);
    expect(paths.some((p) => p.includes("/enhancements/analytics"))).toBe(false);
    expect(JSON.parse(out[0])).toEqual({
      owner: "me",
      totals: { artifacts: 2, downloads: 42, stars: 5 },
      artifacts: [
        { ref: "me/big", kind: "skill", visibility: "public", downloads: 40, stars: 5 },
        { ref: "me/small", kind: "loop", visibility: "private", downloads: 2, stars: 0 },
      ],
      activity: ACTIVITY.entries,
      evolution: { evolving_count: 1, candidates_waiting: 2 },
    });
  });

  it("prints a readable report, sanitized, with the dashboard note for the numbers a token cannot read", async () => {
    serve();
    await stats([]);
    const text = out.join("\n");
    expect(text).toContain("me: 2 artifact(s), 42 downloads, 5 stars");
    expect(text).toContain("  me/big  [skill, public]  40 downloads, 5 stars");
    expect(text).toContain("  2026-10-30  Published me/big 1.2.0 ]0;x ");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("Self-evolution: 1 artifact(s) evolving, 2 proposal(s) waiting for review (`ahood review`).");
    expect(text).toContain(EVOLUTION_DASHBOARD_NOTE);
  });

  it("an unreadable evolution summary leaves evolution null and the rest of the report intact", async () => {
    serve((p) => (p === "/api/v1/enhancements/summary" ? json({ error: "boom" }, 500) : undefined));
    await stats(["--json"]);
    const report = JSON.parse(out[0]);
    expect(report.evolution).toBeNull();
    expect(report.totals.downloads).toBe(42);
  });

  it("rejects an unknown argument before any request", async () => {
    serve();
    await expect(stats(["--all"])).rejects.toThrow(/Usage: ahood stats/);
    expect(paths).toEqual([]);
  });
});

describe("ahood try (alias of `ahood skill read`)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalIsTTY = process.stdout.isTTY;
  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.stdout.isTTY = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.stdout.isTTY = originalIsTTY;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("prints the root document of any kind, with nothing installed", async () => {
    const fetchMock = vi.fn(async () =>
      json({ owner: "alice", slug: "release-loop", kind: "loop", skill_versions: { version: "1.0.0", skill_md_content: "# Release loop\n" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    await COMMANDS.try(["alice/release-loop"]);
    expect(writes.join("")).toBe("# Release loop\n");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/api/v1/skills/alice/release-loop");
  });

  it("has its own help entry that names it an alias", () => {
    expect(findCommandHelp("try")?.desc).toMatch(/alias of `ahood skill read`/);
    expect(findCommandHelp("find")?.usage).toMatch(/^ahood find /);
    expect(findCommandHelp("stats")?.usage).toBe("ahood stats [--json]");
  });
});
