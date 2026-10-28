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
