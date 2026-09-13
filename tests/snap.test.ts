import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { UsageError } from "../src/usage-error.js";
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

    // ahood-cli#134. Every unrecognized token used to be folded into the note
    // body at exit 0, so a typo silently changed what got stored.
    it("rejects a mistyped --tag (singular) instead of storing it as note text", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await expect(createSnap(["my note", "--tag", "deploy"])).rejects.toThrow(/Unknown flag: --tag/);
      expect(calls).toHaveLength(0);
    });

    it("rejects a flag this command doesn't take instead of storing it as note text", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await expect(createSnap(["my note", "--limit", "5"])).rejects.toThrow(/Unknown flag: --limit/);
      expect(calls).toHaveLength(0);
    });

    // The bare-token half of #134: only the token right after --tags is
    // consumed, so "bugfix" used to land in the CONTENT ("note bugfix"). A bare
    // token can't be told from a note word on its own, so the rejected shape is
    // content sitting on both sides of a consumed flag.
    it("rejects space-separated tags rather than folding the extra word into the content", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await expect(createSnap(["note", "--tags", "deploy", "bugfix"])).rejects.toThrow(
        /Note content is split across --tags: "bugfix"/,
      );
      expect(calls).toHaveLength(0);
    });

    // ahood-cli#136: this posted {"content":"note","tags":["a"]} -- "b" was
    // discarded by flagValue's first-wins AND stripped out of the content by
    // the filter, so the word vanished from both fields at exit 0.
    it("rejects a repeated --tags instead of keeping the first value and eating the second", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await expect(createSnap(["note", "--tags", "a", "--tags", "b"])).rejects.toThrow(/--tags given more than once/);
      expect(calls).toHaveLength(0);
    });

    it("still accepts a flags-first invocation, where all the content follows --tags", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await createSnap(["--tags", "deploy", "Debugged", "the", "CI"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "Debugged the CI", tags: ["deploy"] });
    });

    // #134's escape hatch: content is freeform, so a note that genuinely starts
    // with "--" needs a way through the unknown-flag check. `--` previously had
    // no meaning here and was stored as part of the note ("-- my note").
    it("treats a bare -- as end-of-options and keeps what follows as verbatim content", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await createSnap(["--tags", "ci", "--", "--limit 5 broke the parser"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        content: "--limit 5 broke the parser",
        tags: ["ci"],
      });
    });

    it("does not treat --json after -- as a flag", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await createSnap(["--", "--json"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: "--json" });
      expect(logSpy).toHaveBeenCalledWith(ID);
    });

    it("leaves a note that merely contains -- mid-text untouched", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });

      await createSnap(["the flag -- ends options, --json does not"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        content: "the flag -- ends options, --json does not",
      });
    });

    it("leaves the piped-stdin path unaffected by the new flag parsing", async () => {
      const calls = stubApi(201, { id: ID, created_at: "2026-09-08T00:00:00.000Z" });
      stubPipedStdin("Piped session notes.\n");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await createSnap(["--tags", "deploy,bugfix", "--json"]);

      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        content: "Piped session notes.\n",
        tags: ["deploy", "bugfix"],
      });
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

    // ahood-cli#118. Sent verbatim: the server owns the tag-filter contract
    // (ANDed, case-insensitive, 400 past 8 terms, unstorable terms kept so a
    // filter never silently broadens), so the CLI must not re-parse it.
    it("passes --tags through to the query string verbatim", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps(["--tags", "Deploy, bug fix,,x"]);

      expect(new URL(calls[0].url).searchParams.get("tags")).toBe("Deploy, bug fix,,x");
    });

    it("accepts the --tags=value form and combines it with --limit", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps(["--tags=deploy,ci", "--limit", "5"]);

      const params = new URL(calls[0].url).searchParams;
      expect(params.get("tags")).toBe("deploy,ci");
      expect(params.get("limit")).toBe("5");
    });

    it("sends no tags param at all when --tags is omitted", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps([]);

      expect(calls[0].url).toBe(`${API_URL}/api/v1/snaps`);
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

    // ahood-cli#135. The singular typo used to reach the server as no tags
    // param at all, so every snap came back and was printed as though it were
    // the filtered set -- while the sibling `snap search --tag ci` refused the
    // identical typo. No request may be issued: a silently unfiltered result is
    // worse than an error because the user can't tell the two apart.
    it("rejects an unrecognized flag without issuing a request", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });

      await expect(listSnaps(["--tag", "ci"])).rejects.toThrow(/Unknown flag: --tag/);
      expect(calls).toHaveLength(0);
    });

    // UsageError specifically, so exit-code.ts maps it to 2 and it matches what
    // `snap search` already throws for the same typo (ahood-cli#135).
    it("throws a UsageError for an unrecognized flag, not a plain Error", async () => {
      stubApi(200, { snaps: [], next_cursor: null });

      await expect(listSnaps(["--tag", "ci"])).rejects.toThrow(UsageError);
    });

    it("rejects an unrecognized flag even when valid flags are also present", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });

      await expect(listSnaps(["--json", "--limit", "5", "--tags", "ci", "--bogus"])).rejects.toThrow(
        /Unknown flag: --bogus/,
      );
      expect(calls).toHaveLength(0);
    });

    // `snap list` takes no positional argument and index.ts's dispatchSnap
    // consumes only the verb, so a stray token means nothing anywhere and is a
    // mistake rather than something to ignore (ahood-cli#135).
    it("rejects a stray positional without issuing a request", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });

      await expect(listSnaps(["garbage"])).rejects.toThrow(/Unexpected argument: garbage/);
      expect(calls).toHaveLength(0);
    });

    // Regression guard for the reject-leftovers check above: --tags' and
    // --limit's own VALUES are not leftovers, however they're spelled.
    it("still accepts --json, --limit and --tags together in both spellings", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await listSnaps(["--json", "--limit=5", "--tags", "deploy,ci"]);
      await listSnaps(["--json", "--limit", "5", "--tags=deploy,ci"]);

      for (const call of calls) {
        const params = new URL(call.url).searchParams;
        expect(params.get("limit")).toBe("5");
        expect(params.get("tags")).toBe("deploy,ci");
      }
      expect(calls).toHaveLength(2);
    });

    // The sibling flag #136 noted but never exercised: --limit had the same
    // flagValue-plus-filter pairing, so `--limit 1 --limit 2` silently sent
    // limit=1. Refused now, exactly like --tags.
    it("rejects a repeated --limit instead of silently using the first one", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });

      await expect(listSnaps(["--limit", "1", "--limit", "2"])).rejects.toThrow(/--limit given more than once/);
      await expect(listSnaps(["--tags", "a", "--tags", "b"])).rejects.toThrow(/--tags given more than once/);
      expect(calls).toHaveLength(0);
    });

    // The leftover check must not pre-empt flagValue's own missing-value error
    // (ahood-cli#105's swallow-protection), which is the more specific message.
    it("still errors via flagValue when --tags or --limit has no value", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });

      await expect(listSnaps(["--tags"])).rejects.toThrow(/--tags requires a value/);
      await expect(listSnaps(["--limit"])).rejects.toThrow(/--limit requires a value/);
      expect(calls).toHaveLength(0);
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

    // The whole trap of ahood-cli#118: --tags must be declared to
    // parseSearchQuery, or its VALUE gets folded into the joined query and
    // the search silently becomes a text search for "deploy ci".
    it("keeps the --tags value out of the joined query string", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["deploy", "--tags", "ci,green"]);

      const params = new URL(calls[0].url).searchParams;
      expect(params.get("q")).toBe("deploy");
      expect(params.get("tags")).toBe("ci,green");
    });

    it("keeps the --tags=value form out of the joined query string too", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["flaky", "test", "--tags=ci"]);

      const params = new URL(calls[0].url).searchParams;
      expect(params.get("q")).toBe("flaky test");
      expect(params.get("tags")).toBe("ci");
    });

    it("still requires a query when only --tags is given", async () => {
      await expect(searchSnaps(["--tags", "ci"])).rejects.toThrow(/Usage: ahood snap search/);
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

    // The headline reproduction of ahood-cli#136: this issued
    // GET /api/v1/snaps?q=foo&tags=a -- "bar" was dropped by flagValue AND
    // deleted from the query by the filter, so the user got results for a
    // search they never typed, with nothing on stderr.
    it("rejects a repeated --tags instead of dropping its value and deleting the next query word", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });

      await expect(searchSnaps(["foo", "--tags", "a", "--tags", "bar"])).rejects.toThrow(
        /--tags given more than once/,
      );
      await expect(searchSnaps(["foo", "--limit", "1", "--limit", "2"])).rejects.toThrow(
        /--limit given more than once/,
      );
      expect(calls).toHaveLength(0);
    });

    // The other half of #136, and the regression that matters most: the fix
    // must strip only the token the flag actually consumed, so a query word
    // that merely FOLLOWS a value is still part of q.
    it("keeps a query word that follows a flag's value", async () => {
      const calls = stubApi(200, { snaps: [], next_cursor: null });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await searchSnaps(["foo", "--limit", "5", "bar"]);

      const params = new URL(calls[0].url).searchParams;
      expect(params.get("q")).toBe("foo bar");
      expect(params.get("limit")).toBe("5");
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
