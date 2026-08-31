import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { listMine } from "../src/commands/list-mine.js";

const API_URL = "http://ahood.test";

function stubApi(status: number, body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

describe("listMine", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("calls GET /api/v1/skills?mine=true", async () => {
    const calls = stubApi(200, { skills: [] });

    await listMine();

    expect(calls).toEqual([`${API_URL}/api/v1/skills?mine=true`]);
  });

  it("prints a friendly message when the caller has no skills", async () => {
    stubApi(200, { skills: [] });

    await listMine();

    expect(logSpy).toHaveBeenCalledWith("You haven't published any skills yet.");
  });

  it("prints one line per skill including owner, visibility, and stats", async () => {
    stubApi(200, {
      skills: [
        { slug: "demo", name: "Demo", tagline: "a demo", visibility: "public", downloads_count: 5, stars_count: 2, profiles: { username: "alice" } },
        { slug: "secret", name: "Secret", tagline: null, visibility: "private", downloads_count: 0, stars_count: 0, profiles: { username: "alice" } },
      ],
    });

    await listMine();

    expect(logSpy).toHaveBeenCalledWith("alice/demo (public) - Demo: a demo (5 downloads, 2 stars)");
    expect(logSpy).toHaveBeenCalledWith("alice/secret (private) - Secret (0 downloads, 0 stars)");
  });

  it("--json prints the raw skills array, including owner, instead of formatted prose", async () => {
    const skills = [
      { slug: "demo", name: "Demo", tagline: "a demo", visibility: "public", downloads_count: 5, stars_count: 2, profiles: { username: "alice" } },
    ];
    stubApi(200, { skills });

    await listMine(["--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(skills));
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(401, { error: "Unauthorized" });

    await expect(listMine()).rejects.toThrow(/Unauthorized/);
  });
});
