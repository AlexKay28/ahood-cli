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
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("rejects with a usage error when no owner/skill is given", async () => {
    await expect(edit([])).rejects.toThrow(/Usage: ahood skill edit/);
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

  it("sends --homepage and --repository through the same only-passed-flags PATCH", async () => {
    const calls = stubApi(200, {
      slug: SKILL,
      tagline: null,
      license: null,
      visibility: "public",
      tags: [],
      homepage: "https://example.com",
      repository: "https://github.com/alice/demo-skill",
    });

    await edit([
      `${OWNER}/${SKILL}`,
      "--homepage", "https://example.com",
      "--repository", "https://github.com/alice/demo-skill",
    ]);

    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      homepage: "https://example.com",
      repository: "https://github.com/alice/demo-skill",
    });
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(403, { error: "This token's scopes do not include 'publish'" });

    await expect(edit([`${OWNER}/${SKILL}`, "--tagline", "t"])).rejects.toThrow(/publish/);
  });

  it("accepts a --tagline=value with a leading -- via the explicit-equals form", async () => {
    const calls = stubApi(200, { slug: SKILL, tagline: "--fast and cheap", license: null, visibility: "public", tags: [] });

    await edit([`${OWNER}/${SKILL}`, "--tagline=--fast and cheap"]);

    expect(JSON.parse(calls[0].init.body as string)).toEqual({ tagline: "--fast and cheap" });
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

  // ahood-cli#34: a javascript:/data: --homepage or --repository must be
  // rejected client-side, before any network call -- the server stores
  // these verbatim and the web frontend renders them as a raw <a href>.
  it("rejects a javascript: --homepage before making a request", async () => {
    const calls = stubApi(200, {});
    await expect(
      edit([`${OWNER}/${SKILL}`, "--homepage", "javascript:alert(1)"]),
    ).rejects.toThrow(/--homepage must use http:\/\/ or https:\/\//);
    expect(calls).toHaveLength(0);
  });

  it("rejects a data: --repository before making a request", async () => {
    const calls = stubApi(200, {});
    await expect(
      edit([`${OWNER}/${SKILL}`, "--repository", "data:text/html,<script>alert(1)</script>"]),
    ).rejects.toThrow(/--repository must use http:\/\/ or https:\/\//);
    expect(calls).toHaveLength(0);
  });

  it("still accepts a normal https:// --homepage", async () => {
    const calls = stubApi(200, {
      slug: SKILL,
      tagline: null,
      license: null,
      visibility: "public",
      tags: [],
      homepage: "https://example.com",
    });

    await edit([`${OWNER}/${SKILL}`, "--homepage", "https://example.com"]);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ homepage: "https://example.com" });
  });

  // ahood-cli#68: updateSkill (lib/skills/mutations.ts) can return ok:true
  // with a tags_warning attached when a follow-up step involving tags
  // failed. Same class of bug as unpublish's latest_version_warning -- the
  // response body must not be discarded silently.
  it("prints a visible warning when the PATCH response includes tags_warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubApi(200, {
      slug: SKILL,
      tagline: null,
      license: null,
      visibility: "public",
      tags: ["a"],
      tags_warning: "Failed to normalize tags; some tags may not have been saved.",
    });

    await edit([`${OWNER}/${SKILL}`, "--tags", "a"]);

    expect(warnSpy).toHaveBeenCalledWith(
      "WARNING: Failed to normalize tags; some tags may not have been saved.",
    );
  });

  it("prints nothing extra beyond the success line when tags_warning is absent (normal case)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubApi(200, { slug: SKILL, tagline: "t", license: null, visibility: "public", tags: [] });

    await edit([`${OWNER}/${SKILL}`, "--tagline", "t"]);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
