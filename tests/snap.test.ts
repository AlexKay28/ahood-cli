import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { createSnap, listSnaps, searchSnaps, showSnap, removeSnap, shareSnap, unshareSnap, tagsSnap } from "../src/commands/snap.js";

const API_URL = "http://ahood.test";
const ID = "snap_123";

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

// Fake, non-TTY stdin carrying arbitrary piped content -- distinct from
// stubStdio above (which answers a single confirm() question line) since
// createSnap's stdin fallback reads to EOF via 'data'/'end', not readline.
function stubPipedStdin(content: string): void {
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0; isTTY?: boolean };
  fakeStdin.isTTY = undefined;
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
  queueMicrotask(() => {
    fakeStdin.push(content);
    fakeStdin.push(null);
  });
}

function stubTtyStdin(): void {
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0; isTTY?: boolean };
  fakeStdin.isTTY = true;
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
}

describe("snap commands", () => {
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

  describe("createSnap", () => {
    it("rejects with a usage error when no content is given and stdin is a TTY", async () => {
      stubTtyStdin();
      await expect(createSnap([])).rejects.toThrow(/Usage: ahood snap create/);
    });

    it("posts the positional content to /api/v1/snaps", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-07T00:00:00.000Z" });

      await createSnap(["Debugged the flaky CI step."]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps`);
      expect(calls[0].init.method).toBe("POST");
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "Debugged the flaky CI step." });
    });

    it("falls back to reading stdin to completion when no positional content is given", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-07T00:00:00.000Z" });
      stubPipedStdin("Piped session notes.\nMore notes.\n");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await createSnap([]);

      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "Piped session notes.\nMore notes.\n" });
    });

    it("prefers positional content over stdin when both are present", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-07T00:00:00.000Z" });
      stubPipedStdin("should be ignored");

      await createSnap(["explicit content"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "explicit content" });
    });

    it("joins multiple unquoted positional words instead of silently dropping everything after the first", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-07T00:00:00.000Z" });

      await createSnap(["Debugged", "the", "flaky", "CI", "step"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "Debugged the flaky CI step" });
    });

    it("rejects blank/whitespace-only content", async () => {
      await expect(createSnap(["   "])).rejects.toThrow(/Usage: ahood snap create/);
    });

    it("prints the new snap's id in plain mode", async () => {
      stubApi(201, { id: ID, created_at: "2026-09-07T00:00:00.000Z" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await createSnap(["hello"]);

      expect(logSpy).toHaveBeenCalledWith(ID);
    });

    it("--json emits {id, created_at}", async () => {
      const body = { id: ID, created_at: "2026-09-07T00:00:00.000Z" };
      stubApi(201, body);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await createSnap(["hello", "--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(body));
    });

    it("surfaces the server's error message on a non-2xx response", async () => {
      stubApi(400, { error: "Content is required" });
      await expect(createSnap(["hello"])).rejects.toThrow(/Content is required/);
    });

    it("does not send a tags field when --tags is omitted", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await createSnap(["hello"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "hello" });
    });

    it("sends --tags as a trimmed, comma-split tags array without leaking it into the content", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await createSnap(["Debugged", "the", "flaky", "CI", "step", "--tags", "deploy, bugfix"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        content: "Debugged the flaky CI step",
        tags: ["deploy", "bugfix"],
      });
    });

    it("accepts the --tags=value equals form", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await createSnap(["hello", "--tags=deploy,bugfix"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "hello", tags: ["deploy", "bugfix"] });
    });
  });

  describe("listSnaps", () => {
    it("GETs /api/v1/snaps and prints each snap", async () => {
      const calls = stubApi(200, {
        snaps: [{ id: ID, content_preview: "Debugged the flaky CI step.", created_at: "2026-09-07T00:00:00.000Z", updated_at: "now", shared: false }],
        next_cursor: null,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps`);
      expect(logSpy).toHaveBeenCalledWith(`${ID} - Debugged the flaky CI step. (2026-09-07T00:00:00.000Z)`);
    });

    it("marks a shared snap with a (shared) suffix", async () => {
      stubApi(200, {
        snaps: [{ id: ID, content_preview: "note", created_at: "now", updated_at: "now", shared: true }],
        next_cursor: null,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(logSpy).toHaveBeenCalledWith(`${ID} - note (now) (shared)`);
    });

    it("appends tags in brackets after the (shared) marker when present", async () => {
      stubApi(200, {
        snaps: [{ id: ID, content_preview: "note", created_at: "now", updated_at: "now", shared: true, tags: ["deploy", "bugfix"] }],
        next_cursor: null,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(logSpy).toHaveBeenCalledWith(`${ID} - note (now) (shared) [deploy, bugfix]`);
    });

    it("omits the tags suffix when tags is missing or empty", async () => {
      stubApi(200, {
        snaps: [{ id: ID, content_preview: "note", created_at: "now", updated_at: "now", shared: false, tags: [] }],
        next_cursor: null,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(logSpy).toHaveBeenCalledWith(`${ID} - note (now)`);
    });

    it("prints a friendly message when there are no snaps", async () => {
      stubApi(200, { snaps: [], next_cursor: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no snaps yet/));
    });

    it("--json emits the raw snap objects", async () => {
      const snaps = [{ id: ID, content_preview: "note", created_at: "now", updated_at: "now", shared: false }];
      stubApi(200, { snaps, next_cursor: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps(["--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(snaps));
    });

    it("sends --limit as the limit query param", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps(["--limit", "5"]);

      const requestedUrl = new URL(calls[0].url);
      expect(requestedUrl.searchParams.get("limit")).toBe("5");
    });

    it("accepts the --limit=5 equals form", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps(["--limit=5"]);

      const requestedUrl = new URL(calls[0].url);
      expect(requestedUrl.searchParams.get("limit")).toBe("5");
    });

    it("rejects a non-positive --limit", async () => {
      await expect(listSnaps(["--limit", "0"])).rejects.toThrow(/--limit must be a positive integer/);
    });

    it("degrades to the empty-list message instead of crashing when the server returns snaps: null", async () => {
      stubApi(200, { snaps: null, next_cursor: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/no snaps yet/));
    });
  });

  describe("searchSnaps", () => {
    it("rejects with a usage error when no query is given", async () => {
      await expect(searchSnaps([])).rejects.toThrow(/Usage: ahood snap search/);
    });

    it("errors on an unrecognized flag instead of folding it into the query", async () => {
      await expect(searchSnaps(["foo", "--bogus"])).rejects.toThrow(/Unknown flag: --bogus/);
    });

    it("sends ?q=<query> and prints results in the default format", async () => {
      const calls = stubApi(200, {
        snaps: [{ id: ID, content_preview: "flaky ci fix", created_at: "now", updated_at: "now", shared: false }],
        next_cursor: null,
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["flaky", "ci"]);

      const requestedUrl = new URL(calls[0].url);
      expect(requestedUrl.searchParams.get("q")).toBe("flaky ci");
      expect(logSpy).toHaveBeenCalledWith(`${ID} - flaky ci fix (now)`);
    });

    it("--json emits the raw snap objects", async () => {
      const snaps = [{ id: ID, content_preview: "note", created_at: "now", updated_at: "now", shared: false }];
      stubApi(200, { snaps, next_cursor: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["note", "--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(snaps));
    });

    it("sends --limit on the wire as the limit param (space form)", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["foo", "--limit", "5"]);

      const requestedUrl = new URL(calls[0].url);
      expect(requestedUrl.searchParams.get("limit")).toBe("5");
      expect(requestedUrl.searchParams.get("q")).toBe("foo");
    });

    it("accepts the --limit=5 equals form without leaking it into the query (mirrors #105's fix)", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["foo", "--limit=5"]);

      const requestedUrl = new URL(calls[0].url);
      expect(requestedUrl.searchParams.get("limit")).toBe("5");
      expect(requestedUrl.searchParams.get("q")).toBe("foo");
    });

    it("prints a friendly message when there are no results", async () => {
      stubApi(200, { snaps: [], next_cursor: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["nothing"]);

      expect(logSpy).toHaveBeenCalledWith("No snaps found.");
    });

    it("degrades to the empty-results message instead of crashing when the server returns snaps: null", async () => {
      stubApi(200, { snaps: null, next_cursor: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["nothing"]);

      expect(logSpy).toHaveBeenCalledWith("No snaps found.");
    });
  });

  describe("showSnap", () => {
    it("rejects with a usage error when no id is given", async () => {
      await expect(showSnap([])).rejects.toThrow(/Usage: ahood snap show/);
    });

    it("prints the raw content verbatim in plain mode, with no extra trailing newline (mirrors #90/#108's fix)", async () => {
      const detail = {
        id: ID,
        content: "Full session notes.\n",
        created_at: "now",
        updated_at: "now",
        shared: false,
        share_url: null,
      };
      const calls = stubApi(200, detail);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await showSnap([ID]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}`);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith("Full session notes.\n");
    });

    it("--json emits the full snap object", async () => {
      const detail = { id: ID, content: "notes", created_at: "now", updated_at: "now", shared: true, share_url: "https://ahood.test/s/abc" };
      stubApi(200, detail);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await showSnap([ID, "--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(detail));
    });

    it("propagates a fetch/API error", async () => {
      stubApi(404, { error: "not found" });
      await expect(showSnap([ID])).rejects.toThrow(/not found/);
    });
  });

  describe("removeSnap", () => {
    it("rejects with a usage error when no id is given", async () => {
      await expect(removeSnap([])).rejects.toThrow(/Usage: ahood snap remove/);
    });

    it("does not call the API when the user does not type exactly 'yes'", async () => {
      const calls = stubApi(200, { deleted: true });
      stubStdio("n");

      await removeSnap([ID]);

      expect(calls).toHaveLength(0);
    });

    it("DELETEs the snap once the user confirms with 'yes'", async () => {
      const calls = stubApi(200, { deleted: true });
      const stdio = stubStdio("yes");

      await removeSnap([ID]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}`);
      expect(calls[0].init.method).toBe("DELETE");
      expect(stdio.promptedWith()).toMatch(/Delete snap snap_123/);
    });

    it("--yes bypasses the prompt entirely", async () => {
      const calls = stubApi(200, { deleted: true });

      await removeSnap([ID, "--yes"]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}`);
      expect(calls[0].init.method).toBe("DELETE");
    });
  });

  describe("shareSnap", () => {
    it("rejects with a usage error when no id is given", async () => {
      await expect(shareSnap([])).rejects.toThrow(/Usage: ahood snap share/);
    });

    it("POSTs to the share route and prints the share url", async () => {
      const calls = stubApi(200, { share_url: "https://ahood.test/s/abc" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await shareSnap([ID]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}/share`);
      expect(calls[0].init.method).toBe("POST");
      expect(logSpy).toHaveBeenCalledWith("https://ahood.test/s/abc");
    });

    it("--json emits {share_url}", async () => {
      stubApi(200, { share_url: "https://ahood.test/s/abc" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await shareSnap([ID, "--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ share_url: "https://ahood.test/s/abc" }));
    });
  });

  describe("unshareSnap", () => {
    it("rejects with a usage error when no id is given", async () => {
      await expect(unshareSnap([])).rejects.toThrow(/Usage: ahood snap unshare/);
    });

    it("does not call the API when the user does not type exactly 'yes'", async () => {
      const calls = stubApi(200, { shared: false });
      stubStdio("n");

      await unshareSnap([ID]);

      expect(calls).toHaveLength(0);
    });

    it("DELETEs the share route once the user confirms with 'yes'", async () => {
      const calls = stubApi(200, { shared: false });
      const stdio = stubStdio("yes");

      await unshareSnap([ID]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}/share`);
      expect(calls[0].init.method).toBe("DELETE");
      expect(stdio.promptedWith()).toMatch(/Revoke the share link/);
    });

    it("--yes bypasses the prompt entirely", async () => {
      const calls = stubApi(200, { shared: false });

      await unshareSnap([ID, "--yes"]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}/share`);
      expect(calls[0].init.method).toBe("DELETE");
    });
  });

  describe("tagsSnap", () => {
    it("rejects with a usage error when no id is given", async () => {
      await expect(tagsSnap([])).rejects.toThrow(/Usage: ahood snap tags/);
    });

    // ahood-cli#114 review: `snap create` spells this `--tags a,b`, so the
    // same spelling here folded the flag into the tag list and silently
    // replaced the whole set with ["--tags deploy", "bugfix"].
    it("rejects an unknown flag instead of folding it into the tag list", async () => {
      const calls = stubApi(200, { id: ID, tags: [] });

      await expect(tagsSnap([ID, "--tags", "deploy,bugfix"])).rejects.toThrow(/Unknown flag: --tags/);
      expect(calls).toHaveLength(0);
    });

    it("rejects an unknown flag rather than using it as the snap id", async () => {
      const calls = stubApi(200, { id: ID, tags: [] });

      await expect(tagsSnap(["--yes", ID])).rejects.toThrow(/Unknown flag: --yes/);
      expect(calls).toHaveLength(0);
    });

    it("PATCHes the tags route with a trimmed, comma-split tags array, without a confirm prompt", async () => {
      const calls = stubApi(200, { id: ID, tags: ["deploy", "bugfix"] });

      await tagsSnap([ID, "deploy, bugfix"]);

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps/${ID}`);
      expect(calls[0].init.method).toBe("PATCH");
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ tags: ["deploy", "bugfix"] });
    });

    it("clears all tags when no tag list is given", async () => {
      const calls = stubApi(200, { id: ID, tags: [] });

      await tagsSnap([ID]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ tags: [] });
    });

    it("clears all tags when an empty string is given", async () => {
      const calls = stubApi(200, { id: ID, tags: [] });

      await tagsSnap([ID, ""]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ tags: [] });
    });

    it("joins multiple unquoted positional words instead of silently dropping everything after the first", async () => {
      const calls = stubApi(200, { id: ID, tags: ["deploy", "bugfix"] });

      await tagsSnap([ID, "deploy,", "bugfix"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ tags: ["deploy", "bugfix"] });
    });

    it("degrades to the cleared message instead of crashing when the server returns tags: null", async () => {
      stubApi(200, { id: ID, tags: null });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await tagsSnap([ID]);

      expect(logSpy).toHaveBeenCalledWith(`Cleared tags for ${ID}.`);
    });

    it("prints the updated tag list in plain mode", async () => {
      stubApi(200, { id: ID, tags: ["deploy", "bugfix"] });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await tagsSnap([ID, "deploy,bugfix"]);

      expect(logSpy).toHaveBeenCalledWith(`Tags for ${ID}: deploy, bugfix`);
    });

    it("prints a cleared message in plain mode when the result has no tags", async () => {
      stubApi(200, { id: ID, tags: [] });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await tagsSnap([ID]);

      expect(logSpy).toHaveBeenCalledWith(`Cleared tags for ${ID}.`);
    });

    it("--json emits {id, tags}", async () => {
      stubApi(200, { id: ID, tags: ["deploy"] });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await tagsSnap([ID, "deploy", "--json"]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ id: ID, tags: ["deploy"] }));
    });

    it("propagates a fetch/API error (e.g. 404 for a nonexistent/non-owned snap)", async () => {
      stubApi(404, { error: "not found" });
      await expect(tagsSnap([ID, "deploy"])).rejects.toThrow(/not found/);
    });
  });
});
