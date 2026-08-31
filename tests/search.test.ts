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
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects with a usage error when no query is given", async () => {
    await expect(search([])).rejects.toThrow(/Usage: ahood search/);
  });

  it("errors on an unrecognized flag instead of folding it into the query", async () => {
    await expect(search(["foo", "--bogus"])).rejects.toThrow(/Unknown flag: --bogus/);
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
});
