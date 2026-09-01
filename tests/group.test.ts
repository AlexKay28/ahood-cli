import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import {
  createGroup,
  listGroups,
  groupMembers,
  inviteLink,
  joinGroup,
  removeMember,
  leaveGroup,
  deleteGroup,
} from "../src/commands/group.js";

const API_URL = "http://ahood.test";
const SLUG = "design-team";

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

// Routes by pathname so leaveGroup's two sequential calls (GET
// /api/v1/profile, then DELETE the members route) can be exercised with
// independent responses.
function stubApiRoutes(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const pathname = new URL(url).pathname;
      const route = routes[pathname];
      if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

function stubStdio(answer: string): { promptedWith(): string } {
  const written: string[] = [];
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
  const fakeStdout = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream & { fd: 1 };
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(fakeStdout);
  queueMicrotask(() => {
    fakeStdin.push(`${answer}\n`);
    fakeStdin.push(null);
  });
  return { promptedWith: () => written.join("") };
}

describe("group commands", () => {
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

  describe("createGroup", () => {
    it("rejects with a usage error when no name is given", async () => {
      await expect(createGroup([])).rejects.toThrow(/Usage: ahood group create/);
    });

    it("posts name and description to /api/v1/groups", async () => {
      const calls = stubApi(201, { id: "g1", slug: SLUG, name: "Design Team" });

      await createGroup(["Design Team", "--description", "Shared skills"]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups`);
      expect(calls[0].init.method).toBe("POST");
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "Design Team", description: "Shared skills" });
    });

    it("omits description from the body when not passed", async () => {
      const calls = stubApi(201, { id: "g1", slug: SLUG, name: "Design Team" });

      await createGroup(["Design Team"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "Design Team" });
    });

    it("surfaces the server's error message on a non-2xx response", async () => {
      stubApi(400, { error: "Invalid group name" });
      await expect(createGroup(["!!!"])).rejects.toThrow(/Invalid group name/);
    });
  });

  describe("listGroups", () => {
    it("prints each group and its description", async () => {
      stubApi(200, { groups: [{ id: "g1", slug: SLUG, name: "Design Team", description: "desc", owner_user_id: "u1", created_at: "now" }] });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listGroups([]);

      expect(logSpy).toHaveBeenCalledWith(`${SLUG} - Design Team: desc`);
    });

    it("--json emits the raw group objects", async () => {
      const groups = [{ id: "g1", slug: SLUG, name: "Design Team", description: null, owner_user_id: "u1", created_at: "now" }];
      stubApi(200, { groups });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listGroups(["--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(groups));
    });

    it("prints a friendly message when there are no groups", async () => {
      stubApi(200, { groups: [] });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listGroups([]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/don't belong to any groups/));
    });
  });

  describe("groupMembers", () => {
    it("rejects with a usage error when no group is given", async () => {
      await expect(groupMembers([])).rejects.toThrow(/Usage: ahood group members/);
    });

    it("GETs the group detail route and prints members with their role", async () => {
      const calls = stubApi(200, {
        group: { id: "g1", slug: SLUG, name: "Design Team", description: null, owner_user_id: "u1", created_at: "now" },
        members: [{ userId: "u1", username: "alice", avatarUrl: null, role: "owner", joinedAt: "now" }],
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await groupMembers([SLUG]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups/${SLUG}`);
      expect(logSpy).toHaveBeenCalledWith("  alice (owner)");
    });

    it("surfaces a 404 as a not-found error", async () => {
      stubApi(404, { error: "Not found" });
      await expect(groupMembers([SLUG])).rejects.toThrow(/Not found/);
    });
  });

  describe("inviteLink", () => {
    it("rejects with a usage error when no group is given", async () => {
      await expect(inviteLink([])).rejects.toThrow(/Usage: ahood group invite-link/);
    });

    it("POSTs to the invites route and prints the full shareable URL, not just the token", async () => {
      const calls = stubApi(200, { token: "abc123", expiresAt: "2026-09-14T00:00:00.000Z" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await inviteLink([SLUG]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups/${SLUG}/invites`);
      expect(calls[0].init.method).toBe("POST");
      expect(logSpy).toHaveBeenCalledWith(`${API_URL}/groups/join?token=abc123`);
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/shown only this once/));
    });

    it("--json emits {token, expiresAt, url}", async () => {
      stubApi(200, { token: "abc123", expiresAt: "2026-09-14T00:00:00.000Z" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await inviteLink([SLUG, "--json"]);

      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ token: "abc123", expiresAt: "2026-09-14T00:00:00.000Z", url: `${API_URL}/groups/join?token=abc123` }),
      );
    });
  });

  describe("joinGroup", () => {
    it("rejects with a usage error when no argument is given", async () => {
      await expect(joinGroup([])).rejects.toThrow(/Usage: ahood group join/);
    });

    it("accepts a bare raw token and POSTs to the accept route", async () => {
      const calls = stubApi(200, { groupSlug: SLUG, groupName: "Design Team" });

      await joinGroup(["abc123"]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups/invites/abc123/accept`);
      expect(calls[0].init.method).toBe("POST");
    });

    it("extracts the token from a full invite URL", async () => {
      const calls = stubApi(200, { groupSlug: SLUG, groupName: "Design Team" });

      await joinGroup(["https://ahood.vercel.app/groups/join?token=abc123"]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups/invites/abc123/accept`);
    });

    it("prints the joined group's name and slug", async () => {
      stubApi(200, { groupSlug: SLUG, groupName: "Design Team" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await joinGroup(["abc123"]);

      expect(logSpy).toHaveBeenCalledWith(`Joined Design Team (${SLUG}).`);
    });

    it("surfaces the 'invalid or expired' 404 error", async () => {
      stubApi(404, { error: "Invalid or expired invite link" });
      await expect(joinGroup(["deadtoken"])).rejects.toThrow(/Invalid or expired invite link/);
    });
  });

  describe("removeMember", () => {
    it("rejects with a usage error when group or username is missing", async () => {
      await expect(removeMember([])).rejects.toThrow(/Usage: ahood group remove-member/);
      await expect(removeMember([SLUG])).rejects.toThrow(/Usage: ahood group remove-member/);
    });

    it("DELETEs the member route", async () => {
      const calls = stubApi(200, { removed: true });

      await removeMember([SLUG, "bob"]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups/${SLUG}/members/bob`);
      expect(calls[0].init.method).toBe("DELETE");
    });

    it("surfaces the owner-cannot-be-removed error", async () => {
      stubApi(400, { error: "The group owner cannot be removed -- delete the group instead" });
      await expect(removeMember([SLUG, "alice"])).rejects.toThrow(/owner cannot be removed/);
    });
  });

  describe("leaveGroup", () => {
    it("rejects with a usage error when no group is given", async () => {
      await expect(leaveGroup([])).rejects.toThrow(/Usage: ahood group leave/);
    });

    it("resolves the caller's own username via /api/v1/profile, then DELETEs the member route with it", async () => {
      const calls = stubApiRoutes({
        "/api/v1/profile": { status: 200, body: { username: "bob" } },
        [`/api/v1/groups/${SLUG}/members/bob`]: { status: 200, body: { removed: true } },
      });

      await leaveGroup([SLUG]);

      expect(calls.some((c) => c.url === `${API_URL}/api/v1/profile`)).toBe(true);
      const deleteCall = calls.find((c) => c.init.method === "DELETE");
      expect(deleteCall?.url).toBe(`${API_URL}/api/v1/groups/${SLUG}/members/bob`);
    });
  });

  describe("deleteGroup", () => {
    it("rejects with a usage error when no group is given", async () => {
      await expect(deleteGroup([])).rejects.toThrow(/Usage: ahood group delete/);
    });

    it("does not call the API when the user does not type exactly 'yes'", async () => {
      const calls = stubApi(200, { deleted: true });
      stubStdio("y");

      await deleteGroup([SLUG]);

      expect(calls).toHaveLength(0);
    });

    it("calls DELETE on the group once the user confirms with 'yes'", async () => {
      const calls = stubApi(200, { deleted: true });
      const stdio = stubStdio("yes");

      await deleteGroup([SLUG]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/groups/${SLUG}`);
      expect(calls[0].init.method).toBe("DELETE");
      expect(stdio.promptedWith()).toMatch(/permanently delete/);
    });

    it("--yes bypasses the prompt entirely", async () => {
      const calls = stubApi(200, { deleted: true });

      await deleteGroup([SLUG, "--yes"]);

      expect(calls).toHaveLength(1);
      expect(calls[0].init.method).toBe("DELETE");
    });
  });
});
