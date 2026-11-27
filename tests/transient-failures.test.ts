import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { downloadVerifiedArchive } from "../src/commands/add.js";
import { exitCodeFor } from "../src/exit-code.js";
import { apiJson, ApiError, NetworkError } from "../src/http.js";

// ahood-cli#256: failures that are worth retrying must reach the caller as
// exit 6. Everything here is a failure AFTER the response headers arrived --
// the half apiFetch's own try/catch cannot see, because fetch() has already
// resolved by then.

const API_URL = "http://ahood.test";
const OWNER = "alice";
const SKILL = "demo";
const VERSION = "1.0.0";

function metaFor(archive: Buffer) {
  return {
    version: VERSION,
    manifest: [{ path: "SKILL.md" }],
    checksum_sha256: createHash("sha256").update(archive).digest("hex"),
    yanked_at: null,
  };
}

// A 200 whose body errors the way undici errors it: `timeout` is what the
// fetch signal firing mid-body rejects with, `terminated` is the socket dying.
function brokenBodyResponse(kind: "timeout" | "terminated"): Response {
  const error =
    kind === "timeout"
      ? new DOMException("The operation was aborted due to timeout", "TimeoutError")
      : new TypeError("terminated", { cause: new Error("other side closed") });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
    },
    pull(controller) {
      controller.error(error);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("body-read failures are NetworkError, exit 6 (ahood-cli#256)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it.each(["timeout", "terminated"] as const)("apiJson: a %s while reading the body names the URL and exits 6", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => brokenBodyResponse(kind)));

    const caught = await caughtFrom(apiJson("/api/v1/skills"));

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toContain(`${API_URL}/api/v1/skills`);
    expect(exitCodeFor(caught)).toBe(6);
  });

  it.each(["timeout", "terminated"] as const)("archive download: a %s while reading the body names the URL and exits 6", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => brokenBodyResponse(kind)));

    const caught = await caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x"))));

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toContain(`${API_URL}/api/v1/skills/${OWNER}/${SKILL}/download`);
    expect(exitCodeFor(caught)).toBe(6);
  });

  // The wrap must not swallow the reader's own refusals: an oversized archive
  // is not a transport failure and retrying it would never help.
  it("archive download: the size-cap refusal stays a plain error (exit 1), not a NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": String(1024 * 1024 * 1024) } })),
    );

    const caught = await caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x"))));

    expect(caught).not.toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toMatch(/refusing to install/);
    expect(exitCodeFor(caught)).toBe(1);
  });
});

// Not stubbed: a real socket and the real undici, because the claim under
// test is about undici -- that the signal handed to fetch() keeps governing
// the body after the headers are in. Only the timeout's LENGTH is replaced
// (30s -> 100ms); the signal is still the default one apiFetch attaches.
describe("the request timeout covers the body read (ahood-cli#256)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  let server: Server;

  beforeEach(async () => {
    // Headers and the first bytes go out immediately; the rest never does.
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"partial":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.AHOOD_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(100));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("apiJson: a server that sends headers and then stalls fails as NetworkError, exit 6", async () => {
    const caught = await caughtFrom(apiJson("/stall"));

    expect(caught).toBeInstanceOf(NetworkError);
    expect((caught as Error).message).toContain("/stall");
    expect(exitCodeFor(caught)).toBe(6);
  });

  // ahood-cli#270: the download no longer rides the default signal shortened
  // above -- its body is on an idle timeout of its own, shortened here the
  // same way (30s -> 100ms). tests/download-deadline.test.ts covers the rest.
  it("archive download: a server that sends headers and then stalls fails as NetworkError, exit 6", async () => {
    const caught = await caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x")), { idleMs: 100, totalMs: 5_000 }));

    expect(caught).toBeInstanceOf(NetworkError);
    expect(exitCodeFor(caught)).toBe(6);
  });
});

describe("archive download retries a 429 like apiJson does (ahood-cli#256)", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
  });

  it("waits out Retry-After, retries, and returns the verified archive", async () => {
    vi.useFakeTimers();
    const archive = Buffer.from("archive-bytes");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow down" }), { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(new Response(archive, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = downloadVerifiedArchive(OWNER, SKILL, metaFor(archive));
    await vi.advanceTimersByTimeAsync(2_999); // still inside the 3s the server asked for
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await outcome).equals(archive)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the same two retries, as a rate-limit ApiError that exits 6", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 429, headers: { "Retry-After": "7" } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = caughtFrom(downloadVerifiedArchive(OWNER, SKILL, metaFor(Buffer.from("x"))));
    await vi.advanceTimersByTimeAsync(14_000);
    const caught = await outcome;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(429);
    expect((caught as Error).message).toMatch(/Rate limited -- try again in 7 seconds/);
    expect(exitCodeFor(caught)).toBe(6);
  });
});
