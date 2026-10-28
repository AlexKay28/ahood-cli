import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { review } from "../src/commands/review.js";
import { ApiError } from "../src/http.js";
import { exitCodeFor } from "../src/exit-code.js";
import { json } from "./helpers/fake-registry.js";
import { captureConsole, setupEnv, stubMeApi, type MeCall } from "./helpers/me-env.js";

vi.mock("../src/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/confirm.js")>()),
  askLine: vi.fn(async () => "s"),
  isInteractive: vi.fn(() => false),
}));
const confirmMod = await import("../src/confirm.js");
const askLine = vi.mocked(confirmMod.askLine);
const isInteractive = vi.mocked(confirmMod.isInteractive);

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "me-proposals.json"), "utf-8"));
const ID = fixture.items[0].candidate_id as string;

function server(calls: { decide?: Response } = {}) {
  return (call: MeCall) => {
    if (call.method === "GET" && call.path.startsWith("/api/v1/me/proposals")) return json(fixture);
    if (call.method === "POST" && call.path.endsWith("/approve")) return calls.decide ?? json({ status: "promoting", versionId: "v9" });
    if (call.method === "POST" && call.path.endsWith("/reject")) return calls.decide ?? json({ status: "rejected" });
    return json({ error: "Not found" }, 404);
  };
}

describe("ahood review (ahood#979)", () => {
  let env: ReturnType<typeof setupEnv>;
  let io: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    env = setupEnv();
    io = captureConsole();
    isInteractive.mockReturnValue(false);
    askLine.mockResolvedValue("s");
  });
  afterEach(() => env.restore());

  it("lists pending proposals with their evidence (contract fixture); piped, it only lists", async () => {
    const calls = stubMeApi(server());
    await review([]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/me/proposals"]);
    const text = io.stdout();
    expect(text).toContain("1 pending proposal(s):");
    expect(text).toContain(`${ID}  me/my-agent  2.0.0 -> 2.0.1`);
    expect(text).toContain("checks: passed; sandbox: passed; risk findings: 0; probe: improved");
    expect(text).toContain("rationale: Clarify the retry step.\n    Adds an example.");
    expect(text).toContain("`ahood review approve <id>`");
    expect(askLine).not.toHaveBeenCalled();
  });

  it("--json prints the API page; --limit asks for one page", async () => {
    const calls = stubMeApi(server());
    await review(["--json", "--limit", "5"]);
    expect(calls[0].path).toBe("/api/v1/me/proposals?limit=5");
    expect(JSON.parse(io.out[0])).toMatchObject({ total: 1, items: [{ candidate_id: ID }] });
  });

  it("follows next_cursor across pages when no --limit is given", async () => {
    let page = 0;
    const calls = stubMeApi(() => json(page++ === 0 ? { ...fixture, next_cursor: "c2" } : { ...fixture, next_cursor: null }));
    await review(["--json"]);
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/me/proposals", "/api/v1/me/proposals?cursor=c2"]);
    expect(JSON.parse(io.out[0]).items).toHaveLength(2);
  });

  it("approve <id> POSTs the decision, with --version in the body", async () => {
    const calls = stubMeApi(server());
    await review(["approve", ID, "--version", "2.1.0"]);
    expect(calls[0]).toEqual({ method: "POST", path: `/api/v1/me/proposals/${ID}/approve`, body: { version: "2.1.0" } });
    expect(io.stdout()).toContain(`Approved ${ID}: publishing`);
  });

  it("approve --json and the stale outcome", async () => {
    stubMeApi(server({ decide: json({ status: "stale", reason: "base_moved_conflict" }) }));
    await review(["approve", ID, "--json"]);
    expect(JSON.parse(io.out[0])).toEqual({ id: ID, status: "stale", reason: "base_moved_conflict" });
  });

  it("reject <id>", async () => {
    const calls = stubMeApi(server());
    await review(["reject", ID]);
    expect(calls[0]).toMatchObject({ method: "POST", path: `/api/v1/me/proposals/${ID}/reject` });
    expect(io.stdout()).toContain(`Rejected ${ID}.`);
  });

  it("in a terminal, asks per proposal and acts on the answer", async () => {
    isInteractive.mockReturnValue(true);
    askLine.mockResolvedValueOnce("a");
    const calls = stubMeApi(server());
    await review([]);
    expect(askLine).toHaveBeenCalledWith("[a]pprove, [r]eject, [s]kip, [q]uit? ");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/me/proposals", `POST /api/v1/me/proposals/${ID}/approve`]);
    expect(calls[1].body).toEqual({});
  });

  it("asks for a version when the proposal needs one", async () => {
    isInteractive.mockReturnValue(true);
    fixture.items[0].version_input_required = true;
    fixture.items[0].suggested_version = null;
    askLine.mockResolvedValueOnce("a").mockResolvedValueOnce("3.0.0");
    const calls = stubMeApi(server());
    try {
      await review([]);
    } finally {
      fixture.items[0].version_input_required = false;
      fixture.items[0].suggested_version = "2.0.1";
    }
    expect(calls[1].body).toEqual({ version: "3.0.0" });
  });

  it("404 on another owner's (or an unknown) id is a not-found (exit 5)", async () => {
    stubMeApi(() => json({ error: "Not found" }, 404));
    const error = await review(["reject", "nope"]).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(exitCodeFor(error)).toBe(5);
  });

  it("403 without the 'publish' scope keeps the server's scope message (exit 4)", async () => {
    stubMeApi(() => json({ error: "This token's scopes do not include 'publish'" }, 403));
    const error = await review(["approve", ID]).catch((e) => e);
    expect(error.message).toBe("This token's scopes do not include 'publish'");
    expect(exitCodeFor(error)).toBe(4);
  });

  it("429 on a decision reports the server's Retry-After once retries run out", async () => {
    stubMeApi(() => new Response(JSON.stringify({ error: "Too many" }), { status: 429, headers: { "Retry-After": "0" } }));
    await expect(review(["reject", ID])).rejects.toThrow(/Rate limited -- try again in 0 seconds/);
  });

  it("validates its arguments", async () => {
    await expect(review(["approve"])).rejects.toThrow(/Usage: ahood review approve/);
    await expect(review(["approve", ID, "--version", "two"])).rejects.toThrow(/--version must be a semver/);
    await expect(review(["--limit", "0"])).rejects.toThrow(/--limit must be an integer from 1 to 100/);
    await expect(review(["bogus"])).rejects.toThrow(/Unknown argument: bogus/);
  });
});
