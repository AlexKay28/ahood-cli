import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { status, toRow, type ServerStatus } from "../src/commands/status.js";
import { installedPathFor, recordInstall, updateInstalled } from "../src/installed.js";
import { ApiError } from "../src/http.js";
import { exitCodeFor } from "../src/exit-code.js";
import { json } from "./helpers/fake-registry.js";
import { captureConsole, setupEnv, statusFrom, stubMeApi } from "./helpers/me-env.js";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf-8"));

// Records an install and puts something at its path, as a real install would.
function seed(owner: string, slug: string, version: string, kind: "skill" | "agent" | "doc" = "skill") {
  recordInstall({ owner, slug, version, kind, checksum_sha256: "c" });
  const path = installedPathFor(kind, owner, slug);
  if (kind === "skill") mkdirSync(path, { recursive: true });
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
  }
}

describe("ahood status (ahood#979)", () => {
  let env: ReturnType<typeof setupEnv>;
  let io: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    env = setupEnv();
    io = captureConsole();
    stubMeApi(() => json({ error: "unexpected" }, 500));
  });
  afterEach(() => env.restore());

  it("with nothing installed, says so without calling the API (no login needed)", async () => {
    const calls = stubMeApi(() => json({ error: "unexpected" }, 500));
    await status([]);
    expect(calls).toEqual([]);
    expect(io.stdout()).toContain("Nothing installed with ahood yet");
  });

  it("POSTs the lockfile as {installed: [{owner, slug, version}]}", async () => {
    seed("alice", "pdf-tools", "1.0.0");
    seed("me", "my-agent", "2.0.0", "agent");
    const calls = stubMeApi(() => json(fixture("me-status.json")));
    await status(["--json"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/api/v1/me/status");
    expect(calls[0].body).toEqual({
      installed: [
        { owner: "alice", slug: "pdf-tools", version: "1.0.0" },
        { owner: "me", slug: "my-agent", version: "2.0.0" },
      ],
    });
  });

  it("--json reports installed vs latest, update, pin and evolution per install (contract fixture)", async () => {
    seed("alice", "pdf-tools", "1.0.0");
    seed("me", "my-agent", "2.0.0", "agent");
    seed("bob", "gone", "0.1.0");
    updateInstalled((f) => void (f.items[0].pinned = "1.0.0"));
    stubMeApi(() => json(fixture("me-status.json")));
    await status(["--json"]);
    const out = JSON.parse(io.out[0]);
    expect(out.plan).toEqual({ evolution_available: true, consented: true });
    const [pdf, agent, gone] = out.items;
    expect(pdf).toMatchObject({
      owner: "alice", slug: "pdf-tools", kind: "skill", installed_version: "1.0.0", latest_version: "1.1.0",
      update_available: true, pinned: "1.0.0", sync_target: null, status: "ok", is_owner: false, evolution: null,
    });
    expect(agent).toMatchObject({
      update_available: false, sync_target: null, is_owner: true,
      evolution: { enabled: true, promotion_mode: "review", probe_mode: "shadow", pending_proposals: 2 },
    });
    expect(gone).toMatchObject({ status: "not_found", latest_version: null, sync_target: null });
  });

  it("flags an install whose files were deleted by hand", async () => {
    recordInstall({ owner: "alice", slug: "pdf-tools", version: "1.0.0", kind: "skill", checksum_sha256: "c" });
    stubMeApi(() => json(fixture("me-status.json")));
    await status([]);
    expect(io.stdout()).toContain("files missing");
  });

  it("prints a table, the update count, and own-artifact evolution with a review pointer", async () => {
    seed("alice", "pdf-tools", "1.0.0");
    seed("me", "my-agent", "2.0.0", "agent");
    stubMeApi(() => json(fixture("me-status.json")));
    await status([]);
    const text = io.stdout();
    expect(text).toMatch(/alice\/pdf-tools\s+skill\s+1\.0\.0\s+1\.1\.0\s+update available/);
    expect(text).toContain("1 update(s) available -- run `ahood sync`");
    expect(text).toContain("me/my-agent: evolution on, review mode, probe shadow; 2 pending proposal(s)");
    expect(text).toContain("Run `ahood review`");
  });

  it("computes update_available per install, not per artifact", () => {
    const server = fixture("me-status.json") as ServerStatus;
    const item = { owner: "alice", slug: "pdf-tools", version: "1.1.0", kind: "skill" as const, installedPath: "/x", projectDir: "/", installedAt: "t" };
    expect(toRow(item, server.items[0])).toMatchObject({ update_available: false, sync_target: null });
    expect(toRow({ ...item, version: "1.0.0", pinned: "0.9.0" }, server.items[0])).toMatchObject({ sync_target: "0.9.0" });
  });

  it("imports the current project's legacy lockfile pins before asking", async () => {
    const { writeLockfileEntry } = await import("../src/lockfile.js");
    writeLockfileEntry(".claude/skills.lock.json", "alice/pdf-tools", { version: "1.0.0", checksum_sha256: "c" });
    const calls = stubMeApi(statusFrom({ "alice/pdf-tools": { kind: "skill", latest: "1.0.0" } }));
    await status(["--json"]);
    expect((calls[0].body as { installed: unknown[] }).installed).toEqual([{ owner: "alice", slug: "pdf-tools", version: "1.0.0" }]);
  });

  it("sends one request per 500 distinct artifacts", async () => {
    updateInstalled((f) => {
      for (let i = 0; i < 501; i++) {
        f.items.push({ owner: "o", slug: `s${i}`, version: "1.0.0", kind: "skill", installedPath: `/p/${i}`, projectDir: "/p", installedAt: "t" });
      }
    });
    const calls = stubMeApi(statusFrom({}));
    await status(["--json"]);
    expect(calls.map((c) => (c.body as { installed: unknown[] }).installed.length)).toEqual([500, 1]);
  });

  it("401 surfaces as an auth error (exit 4) so main() tells the user to log in", async () => {
    seed("alice", "pdf-tools", "1.0.0");
    stubMeApi(() => json({ error: "Unauthorized" }, 401));
    const error = await status([]).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(exitCodeFor(error)).toBe(4);
  });

  it("403 on a token without 'read' carries the server's scope message", async () => {
    seed("alice", "pdf-tools", "1.0.0");
    stubMeApi(() => json({ error: "This token's scopes do not include 'read'" }, 403));
    await expect(status([])).rejects.toMatchObject({ status: 403, message: "This token's scopes do not include 'read'" });
  });

  it("429 honours Retry-After and then succeeds", async () => {
    seed("alice", "pdf-tools", "1.0.0");
    let n = 0;
    const calls = stubMeApi(() =>
      n++ === 0
        ? new Response(JSON.stringify({ error: "Too many" }), { status: 429, headers: { "Retry-After": "0" } })
        : json(fixture("me-status.json")),
    );
    await status(["--json"]);
    expect(calls).toHaveLength(2);
  });

  it("rejects unknown arguments", async () => {
    await expect(status(["--verbose"])).rejects.toThrow(/Unknown argument: --verbose/);
  });
});
