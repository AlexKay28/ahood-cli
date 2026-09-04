import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";

const API_URL = "http://ahood.test";

type TextContent = { type: "text"; text: string };

function stubApi(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

function stubApiRoutes(routes: Record<string, { status: number; body?: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const route = routes[pathname];
      if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstTextBody(content: unknown): unknown {
  return JSON.parse((content as TextContent[])[0].text);
}

describe("ahood mcp tools", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;
  const originalHome = process.env.HOME;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let dir: string;

  beforeEach(() => {
    // resolveToken() falls back to ~/.config/ahood/credentials.json when
    // AHOOD_TOKEN is unset (see tests/whoami.test.ts) -- point HOME at an
    // empty temp dir so the "no token" whoami test below can never pick up
    // a real (or another test's) stored login, whatever machine/order this
    // runs under.
    dir = mkdtempSync(join(tmpdir(), "ahood-mcp-test-"));
    process.env.HOME = dir;
    delete process.env.XDG_CONFIG_HOME;
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("lists exactly the 6 v1 tools", async () => {
    const client = await connectedClient();

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      ["skill_list", "skill_read", "skill_search", "skill_versions", "skill_view", "whoami"].sort(),
    );
  });

  it("skill_search returns the skills array as tool content", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: null, downloads_count: 3, profiles: { username: "alice" } }];
    stubApi(200, { skills });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_search", arguments: { query: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(skills);
  });

  it("skill_search maps a 404 to a structured isError result with error_code not_found", async () => {
    stubApi(404, { error: "not found" });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_search", arguments: { query: "demo" } });

    expect(result.isError).toBe(true);
    expect((firstTextBody(result.content) as { error_code: string }).error_code).toBe("not_found");
  });

  it("skill_view returns the skill detail object", async () => {
    const detail = { slug: "demo", name: "Demo", owner: "alice", tags: [], downloads_count: 0, stars_count: 0, skill_versions: null };
    stubApi(200, detail);
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_view", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(detail);
  });

  it("skill_read returns version and content", async () => {
    stubApi(200, { owner: "alice", slug: "demo", skill_versions: { version: "1.0.0", skill_md_content: "# Demo" } });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_read", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual({ version: "1.0.0", content: "# Demo" });
  });

  it("skill_read maps 'no published version' to a general_error isError result", async () => {
    stubApi(200, { owner: "alice", slug: "demo", skill_versions: null });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_read", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBe(true);
    const body = firstTextBody(result.content) as { error_code: string; error: string };
    expect(body.error_code).toBe("general_error");
    expect(body.error).toMatch(/no published version/);
  });

  it("skill_versions returns the versions array", async () => {
    const versions = [{ version: "1.0.0", changelog_md: null, package_size_bytes: 100, status: "published", created_at: "2026-01-01" }];
    stubApi(200, { versions });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_versions", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(versions);
  });

  it("skill_list returns the caller's own skills", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: null, visibility: "public", downloads_count: 0, stars_count: 0, profiles: { username: "alice" } }];
    stubApi(200, { skills });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_list", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(skills);
  });

  it("skill_list maps a 401 to an auth_error isError result", async () => {
    stubApi(401, { error: "unauthorized" });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_list", arguments: {} });

    expect(result.isError).toBe(true);
    expect((firstTextBody(result.content) as { error_code: string }).error_code).toBe("auth_error");
  });

  it("whoami reports authenticated:false with no token, never as isError", async () => {
    delete process.env.AHOOD_TOKEN;
    const client = await connectedClient();

    const result = await client.callTool({ name: "whoami", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual({ authenticated: false, reason: "not_logged_in" });
  });

  it("whoami reports authenticated:true for a valid session token", async () => {
    stubApiRoutes({ "/api/v1/auth/tokens": { status: 200, body: { tokens: [] } } });
    const client = await connectedClient();

    const result = await client.callTool({ name: "whoami", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual({ authenticated: true, mode: "session" });
  });
});
