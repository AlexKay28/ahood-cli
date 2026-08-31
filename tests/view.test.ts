import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { view } from "../src/commands/view.js";

const API_URL = "http://ahood.test";

describe("view", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("rejects with a usage error when no spec is given", async () => {
    await expect(view([])).rejects.toThrow(/Usage: ahood view/);
  });

  it("rejects a malformed spec via the shared validator", async () => {
    await expect(view(["alice/.."])).rejects.toThrow(/Invalid skill/);
  });

  it("--json prints the raw skill object", async () => {
    const detail = {
      slug: "demo",
      name: "Demo",
      tagline: "a demo",
      visibility: "public",
      downloads_count: 3,
      stars_count: 1,
      skill_versions: { version: "1.0.0", checksum_sha256: "abc" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 })));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await view(["alice/demo", "--json"]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(detail));
  });
});
