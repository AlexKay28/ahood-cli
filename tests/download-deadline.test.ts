import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DOWNLOAD_DEADLINE, downloadVerifiedArchive } from "../src/commands/add.js";
import { exitCodeFor } from "../src/exit-code.js";
import { apiFetch, NetworkError, type ProgressDeadline } from "../src/http.js";

// ahood-cli#270: the archive download used to share the 30s TOTAL request
// deadline, so a large archive on a slow link could never finish. It is now
// judged on progress. Real sockets and the real undici throughout: the claims
// are about what a live body stream does when the fetch signal is aborted.

const OWNER = "alice";
const SKILL = "demo";

function metaFor(archive: Buffer) {
  return {
    version: "1.0.0",
    manifest: [{ path: "SKILL.md" }],
    checksum_sha256: createHash("sha256").update(archive).digest("hex"),
    yanked_at: null,
  };
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

// The production shape (headers 30s / idle 30s / total 800s) scaled down so a
// stall is detected in a fraction of a second.
const FAST: ProgressDeadline = { headersMs: 150, idleMs: 150, totalMs: 5_000 };

describe("archive download is judged on progress, not total time (ahood-cli#270)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  let server: Server;
  let handler: RequestListener;
  const timers = new Set<NodeJS.Timeout>();

  // One chunk every `everyMs` until `chunks` have gone out, then end.
  function drip(chunks: Buffer[], everyMs: number): RequestListener {
    return (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) res.write(chunks[i++]);
        if (i === chunks.length) {
          clearInterval(timer);
          timers.delete(timer);
          res.end();
        }
      }, everyMs);
      timers.add(timer);
    };
  }

  beforeEach(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.AHOOD_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("a slow but steady body outlives the old total deadline and still installs", async () => {
    // The old behaviour, shortened: a TOTAL deadline of 100ms on the default
    // signal. If the download still used it, this 600ms body would abort.
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(100));
    const chunks = Array.from({ length: 15 }, (_, i) => Buffer.alloc(64, i));
    const archive = Buffer.concat(chunks);
    handler = drip(chunks, 40); // 600ms in all: 4x the idle and headers bounds, never idle for 150ms

    const started = Date.now();
    const buffer = await downloadVerifiedArchive(OWNER, SKILL, metaFor(archive), FAST);

    expect(buffer.equals(archive)).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(FAST.idleMs * 2);
  });

  it("a body that stalls mid-stream fails within the idle bound as NetworkError, exit 6", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.write("first bytes, then nothing");
    };

    const started = Date.now();
    const caught = await caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x")), FAST));
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toContain(`/api/v1/skills/${OWNER}/${SKILL}/download`);
    expect((caught as Error).message).toMatch(/no data received for 0\.2s/);
    expect(exitCodeFor(caught)).toBe(6);
    // Bounded by the idle timeout, nowhere near the 5s total cap.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("a server that never sends headers still fails within the headers bound", async () => {
    handler = () => {
      // accepts the request and never answers
    };

    const started = Date.now();
    const caught = await caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x")), FAST));
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toMatch(/no response within 0\.2s/);
    expect(exitCodeFor(caught)).toBe(6);
    expect(elapsed).toBeLessThan(2_000);
  });

  // The reason the idle timeout is not the only bound: a server can stay
  // "active" forever by dripping.
  it("a body that never idles but never finishes is cut off by the total cap", async () => {
    const chunks = Array.from({ length: 200 }, () => Buffer.from("."));
    handler = drip(chunks, 30);

    const started = Date.now();
    const caught = await caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x")), { ...FAST, totalMs: 400 }));
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toMatch(/not complete after 0\.4s/);
    expect(exitCodeFor(caught)).toBe(6);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("production download deadline (ahood-cli#270)", () => {
  it("keeps the 30s idle bound and derives the total cap from the 50 MB limit at 64 KiB/s", () => {
    expect(DOWNLOAD_DEADLINE.idleMs).toBe(30_000);
    expect(DOWNLOAD_DEADLINE.totalMs).toBe(800_000);
    // Unset on purpose: connect + headers keep apiFetch's own 30s default.
    expect(DOWNLOAD_DEADLINE.headersMs).toBeUndefined();
  });
});

// A timer left armed keeps the event loop alive: the command would print its
// result and then sit there until the timer fired -- up to the 800s total cap.
describe("progress-deadline timers never outlive the request (ahood-cli#270)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const deadline: ProgressDeadline = { idleMs: 30_000, totalMs: 800_000 };

  beforeEach(() => {
    process.env.AHOOD_API_URL = "http://ahood.test";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("clears them once the body has been read to the end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("archive-bytes", { status: 200 })));

    const res = await apiFetch("/x", {}, { progressDeadline: deadline });
    expect(vi.getTimerCount()).toBe(2); // idle + total, armed while the body is outstanding
    expect(await res.text()).toBe("archive-bytes");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears them when the reader gives up early (the size-cap refusal path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("archive-bytes", { status: 200 })));

    const res = await apiFetch("/x", {}, { progressDeadline: deadline });
    await res.body?.cancel();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears them when the body errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    const res = await apiFetch("/x", {}, { progressDeadline: deadline });
    await expect(res.text()).rejects.toThrow("terminated");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears them when the request fails before any headers, or has no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(apiFetch("/x", {}, { progressDeadline: deadline })).rejects.toBeInstanceOf(NetworkError);
    expect(vi.getTimerCount()).toBe(0);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await apiFetch("/x", {}, { progressDeadline: deadline });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a caller's own signal still aborts the request", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);
      throw init.signal?.reason;
    });
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    caller.abort(new Error("caller gave up"));

    const caught = await apiFetch("/x", { signal: caller.signal }, { progressDeadline: deadline }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toContain("caller gave up");
    expect(vi.getTimerCount()).toBe(0);
  });
});
