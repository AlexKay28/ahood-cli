import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { star, unstar } from "../src/commands/star.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "demo-skill";

function stubApi(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

describe("star", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("rejects with a usage error when no owner/skill is given", async () => {
    await expect(star([])).rejects.toThrow(/Usage: ahood star/);
  });

  it("rejects when the spec has no slash", async () => {
    await expect(star(["not-a-spec"])).rejects.toThrow(/Usage: ahood star/);
  });

  it("sends a POST to the star route", async () => {
    const calls = stubApi(200, { starred: true });

    await star([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/star`);
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_test");
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(403, { error: "This token's scopes do not include 'publish'" });

    await expect(star([`${OWNER}/${SKILL}`])).rejects.toThrow(/publish/);
  });
});

describe("unstar", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("rejects with a usage error when no owner/skill is given", async () => {
    await expect(unstar([])).rejects.toThrow(/Usage: ahood unstar/);
  });

  it("sends a DELETE to the star route", async () => {
    const calls = stubApi(200, { starred: false });

    await unstar([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/star`);
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(404, { error: "Not found" });

    await expect(unstar([`${OWNER}/${SKILL}`])).rejects.toThrow(/Not found/);
  });
});
