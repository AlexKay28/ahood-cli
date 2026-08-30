import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { unpublish } from "../src/commands/unpublish.js";

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "demo-skill";

function stubApi(status: number, body: unknown = { deleted: true }) {
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

// unpublish() reads a confirmation line from stdin via
// node:readline/promises -- feed it one directly instead of touching the
// real terminal, and capture what gets written to stdout as the prompt.
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

describe("unpublish", () => {
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
    await expect(unpublish([])).rejects.toThrow(/Usage: ahood unpublish/);
  });

  it("does not call the API when the user does not type exactly 'yes'", async () => {
    const calls = stubApi(200);
    stubStdio("y");

    await unpublish([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(0);
  });

  it("calls DELETE on the skill once the user confirms with 'yes'", async () => {
    const calls = stubApi(200);
    const stdio = stubStdio("yes");

    await unpublish([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}`);
    expect(calls[0].init.method).toBe("DELETE");
    expect(stdio.promptedWith()).toMatch(/permanently delete/);
  });

  it("is case-insensitive on the confirmation ('YES' still confirms)", async () => {
    const calls = stubApi(200);
    stubStdio("YES");

    await unpublish([`${OWNER}/${SKILL}`]);

    expect(calls).toHaveLength(1);
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    stubApi(404, { error: "Not found" });
    stubStdio("yes");

    await expect(unpublish([`${OWNER}/${SKILL}`])).rejects.toThrow(/Not found/);
  });
});
