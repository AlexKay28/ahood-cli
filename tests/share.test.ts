import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { share, unshare } from "../src/commands/share.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "demo-skill";
const GROUP = "design-team";

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

describe("share", () => {
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
    await expect(share([])).rejects.toThrow(/Usage: ahood skill share/);
  });

  it("rejects with a usage error when --group is missing", async () => {
    await expect(share([`${OWNER}/${SKILL}`])).rejects.toThrow(/Usage: ahood skill share/);
  });

  it("posts group_slug to the share route", async () => {
    const calls = stubApi(200, { shared: true });

    await share([`${OWNER}/${SKILL}`, "--group", GROUP]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/share`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ group_slug: GROUP });
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(403, { error: "You do not own this skill" });
    await expect(share([`${OWNER}/${SKILL}`, "--group", GROUP])).rejects.toThrow(/do not own/);
  });
});

describe("unshare", () => {
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
    await expect(unshare([])).rejects.toThrow(/Usage: ahood skill unshare/);
  });

  it("rejects with a usage error when --group is missing", async () => {
    await expect(unshare([`${OWNER}/${SKILL}`])).rejects.toThrow(/Usage: ahood skill unshare/);
  });

  it("sends a DELETE to the share route with the group slug in the path", async () => {
    const calls = stubApi(200, { shared: false });

    await unshare([`${OWNER}/${SKILL}`, "--group", GROUP]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/share/${GROUP}`);
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(404, { error: "Not shared with this group" });
    await expect(unshare([`${OWNER}/${SKILL}`, "--group", GROUP])).rejects.toThrow(/Not shared/);
  });
});
