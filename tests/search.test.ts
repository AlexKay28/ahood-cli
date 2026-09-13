import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { search } from "../src/commands/search.js";

const API_URL = "http://ahood.test";

describe("search", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects with a usage error when no query is given", async () => {
    await expect(search([])).rejects.toThrow(/Usage: ahood skill search/);
  });

  it("errors on an unrecognized flag instead of folding it into the query", async () => {
    await expect(search(["foo", "--bogus"])).rejects.toThrow(/Unknown flag: --bogus/);
  });

  // parseSearchQuery takes its extra value-flags per caller, so --tags being
  // added to `snap search` (ahood-cli#118) must not quietly become an ignored
  // no-op here -- silently dropping it would return unfiltered results while
  // looking like it filtered.
  it("still errors on --tags, which this command does not implement", async () => {
    await expect(search(["foo", "--tags", "ci"])).rejects.toThrow(/Unknown flag: --tags/);
  });

  // ahood-cli#136 was filed against `snap search`, but the bug lived in the
  // shared flagValue/parseSearchQuery pair, so this command had it too:
  // `--limit 1 --limit 2` searched with per_page=1, and a query word sitting
  // after the second --limit was deleted from q. Refusing the repeat is
  // therefore a deliberate behaviour change here as well, not a side effect.
  it("rejects a repeated --limit rather than silently using the first one", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(search(["foo", "--limit", "1", "--limit", "2"])).rejects.toThrow(/--limit given more than once/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The stripping half of #136: only the occurrence that consumed a value may
  // remove one, so a query word after --limit's value stays in q.
  it("keeps a query word that follows --limit's value", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["foo", "--limit", "5", "bar"]);

    const params = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
    expect(params.get("q")).toBe("foo bar");
    expect(params.get("per_page")).toBe("5");
  });

  it("--json prints the raw skills array instead of formatted prose", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: null, downloads_count: 3, profiles: { username: "alice" } }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["demo", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(skills));
  });

  it("prints owner/slug for each result in the default format", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: "does things", downloads_count: 3, profiles: { username: "alice" } }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["demo"]);

    expect(logSpy).toHaveBeenCalledWith("alice/demo - Demo: does things (3 downloads)");
  });

  it("sends --limit on the wire as the server's per_page param, not limit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["foo", "--limit", "5"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("per_page")).toBe("5");
    expect(requestedUrl.searchParams.has("limit")).toBe(false);
  });

  it("omits per_page entirely when --limit isn't given, preserving the server's own default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["foo"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.has("per_page")).toBe(false);
    expect(requestedUrl.searchParams.has("limit")).toBe(false);
  });

  it("accepts the --limit=5 equals form, not just the space form (#105)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["foo", "--limit=5"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("per_page")).toBe("5");
  });

  it("falls back to '(unknown)' instead of crashing when a result's profiles join is null (#106)", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: null, downloads_count: 3, profiles: null }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills }), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await search(["demo"]);

    expect(logSpy).toHaveBeenCalledWith("(unknown)/demo - Demo (3 downloads)");
  });
});
