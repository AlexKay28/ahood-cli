import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnap } from "../src/commands/snap.js";
import { dispatchSnap } from "../src/index.js";
import { json } from "./helpers/fake-registry.js";
import { captureConsole, setupEnv } from "./helpers/me-env.js";

describe("structured snaps (ahood#979, server ahood#946)", () => {
  let env: ReturnType<typeof setupEnv>;
  let io: ReturnType<typeof captureConsole>;
  let bodies: unknown[];
  beforeEach(() => {
    env = setupEnv();
    io = captureConsole();
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        bodies.push(JSON.parse(init.body as string));
        return json({ id: "snap-1", created_at: "t" }, 201);
      }),
    );
  });
  afterEach(() => env.restore());

  it("sends the five header fields as `structured`", async () => {
    await createSnap([
      "pdf split bug",
      "--failed", "pages out of order",
      "--worked", "sorting",
      "--fix", "sort by index",
      "--lesson", "keep page order explicit",
      "--artifact", "alice/pdf-tools@1.0.0",
    ]);
    expect(bodies[0]).toEqual({
      content: "pdf split bug",
      structured: { failed: "pages out of order", worked: "sorting", fix: "sort by index", lesson: "keep page order explicit", artifact: "alice/pdf-tools@1.0.0" },
    });
    expect(io.out).toEqual(["snap-1"]);
    expect(io.stderr()).toContain("private snap -- only you can see it");
  });

  it("a freeform snap's body is unchanged (no structured key)", async () => {
    await createSnap(["just a note", "--tags", "a,b"]);
    expect(bodies[0]).toEqual({ content: "just a note", tags: ["a", "b"] });
  });

  it("refuses a malformed --artifact locally", async () => {
    await expect(createSnap(["note", "--artifact", "not a ref"])).rejects.toThrow(/--artifact must be owner\/slug/);
    expect(bodies).toEqual([]);
  });

  it("`ahood snap --lesson ... <content>` (no verb) is a create", async () => {
    await dispatchSnap(["--lesson", "x", "the note", "--json"]);
    expect(bodies[0]).toEqual({ content: "the note", structured: { lesson: "x" } });
    expect(JSON.parse(io.out[0])).toEqual({ id: "snap-1", created_at: "t" });
  });
});

// SNAP PROTOCOL: the server's 201 body now carries `evolution`, saying whether
// this snap feeds an artifact's self-evolution and why not when it doesn't.
describe("the server's `evolution` field (SNAP PROTOCOL)", () => {
  let env: ReturnType<typeof setupEnv>;
  let io: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    env = setupEnv();
    io = captureConsole();
  });
  afterEach(() => env.restore());

  function stubCreateResponse(extra: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ id: "snap-1", created_at: "t", ...extra }, 201)),
    );
  }

  it("prints the evolution message on its own line", async () => {
    stubCreateResponse({
      evolution: {
        artifact: "alice/pdf-tools",
        status: "ok",
        feeds_evolution: true,
        message: "Feeds alice/pdf-tools' evolution.",
        enrolled: ["alice/pdf-tools"],
      },
    });

    await createSnap(["pdf split bug", "--artifact", "alice/pdf-tools"]);

    expect(io.err).toContain("Feeds alice/pdf-tools' evolution.");
  });

  it("also prints the enrolled list when the snap does not feed any artifact's evolution", async () => {
    stubCreateResponse({
      evolution: {
        artifact: null,
        status: "absent",
        feeds_evolution: false,
        message: "No artifact given -- this snap won't feed any artifact's evolution.",
        enrolled: ["alice/pdf-tools", "alice/cli-helper"],
      },
    });

    await createSnap(["just a note"]);

    expect(io.err).toContain("No artifact given -- this snap won't feed any artifact's evolution.");
    expect(io.err.some((line) => line.includes("alice/pdf-tools") && line.includes("alice/cli-helper"))).toBe(true);
  });

  it("omits the enrolled line when feeds_evolution is false but nothing is enrolled", async () => {
    stubCreateResponse({
      evolution: {
        artifact: "alice/not-mine",
        status: "other_owner",
        feeds_evolution: false,
        message: "alice/not-mine is not yours -- this snap won't feed its evolution.",
        enrolled: [],
      },
    });

    await createSnap(["just a note", "--artifact", "alice/not-mine"]);

    expect(io.err).toContain("alice/not-mine is not yours -- this snap won't feed its evolution.");
    expect(io.err.some((line) => line.startsWith("Enrolled"))).toBe(false);
  });

  it("prints nothing extra when an older server sends no `evolution` field at all", async () => {
    stubCreateResponse({});

    await createSnap(["just a note"]);

    expect(io.stderr()).toContain("private snap -- only you can see it");
    expect(io.err).toHaveLength(1);
  });

  it("--json passes the evolution field through untouched", async () => {
    stubCreateResponse({
      evolution: {
        artifact: "alice/pdf-tools",
        status: "ok",
        feeds_evolution: true,
        message: "Feeds alice/pdf-tools' evolution.",
        enrolled: ["alice/pdf-tools"],
      },
    });

    await createSnap(["hello", "--json"]);

    expect(JSON.parse(io.out[0])).toEqual({
      id: "snap-1",
      created_at: "t",
      evolution: {
        artifact: "alice/pdf-tools",
        status: "ok",
        feeds_evolution: true,
        message: "Feeds alice/pdf-tools' evolution.",
        enrolled: ["alice/pdf-tools"],
      },
    });
    // --json is a pure passthrough: no extra lines on stderr either.
    expect(io.err).toHaveLength(0);
  });
});
