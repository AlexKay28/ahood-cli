import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { edit } from "../src/commands/edit.js";

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

describe("edit", () => {
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
    await expect(edit([])).rejects.toThrow(/Usage: ahood edit/);
  });

  it("rejects when no update flags are given", async () => {
    await expect(edit([`${OWNER}/${SKILL}`])).rejects.toThrow(/Nothing to update/);
  });

  it("sends a PATCH with only the flags that were passed", async () => {
    const calls = stubApi(200, { slug: SKILL, tagline: "new tagline", license: null, visibility: "public", tags: [] });

    await edit([`${OWNER}/${SKILL}`, "--tagline", "new tagline"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ tagline: "new tagline" });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_test");
  });

  it("splits --tags on commas and trims whitespace", async () => {
    const calls = stubApi(200, { slug: SKILL, tagline: null, license: null, visibility: "public", tags: ["a", "b"] });

    await edit([`${OWNER}/${SKILL}`, "--tags", "a, b ,, "]);

    expect(JSON.parse(calls[0].init.body as string)).toEqual({ tags: ["a", "b"] });
  });

  it("combines multiple flags into a single request body", async () => {
    const calls = stubApi(200, { slug: SKILL, tagline: "t", license: "MIT", visibility: "private", tags: [] });

    await edit([`${OWNER}/${SKILL}`, "--tagline", "t", "--license", "MIT", "--visibility", "private"]);

    expect(JSON.parse(calls[0].init.body as string)).toEqual({ tagline: "t", license: "MIT", visibility: "private" });
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(403, { error: "This token's scopes do not include 'publish'" });

    await expect(edit([`${OWNER}/${SKILL}`, "--tagline", "t"])).rejects.toThrow(/publish/);
  });

  it("errors instead of swallowing the next flag as this one's value", async () => {
    await expect(
      edit([`${OWNER}/${SKILL}`, "--tagline", "--visibility", "public"]),
    ).rejects.toThrow(/--tagline requires a value/);
  });

  it("errors on a trailing flag with no value instead of silently dropping it", async () => {
    await expect(edit([`${OWNER}/${SKILL}`, "--tagline"])).rejects.toThrow(/--tagline requires a value/);
  });

  it("rejects an invalid --visibility value before making a request", async () => {
    const calls = stubApi(200, {});
    await expect(edit([`${OWNER}/${SKILL}`, "--visibility", "publik"])).rejects.toThrow(/must be "public" or "private"/);
    expect(calls).toHaveLength(0);
  });
});
