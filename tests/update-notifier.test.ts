// ahood#1552 step 5 / ahood#1554 step 5: the passive update notifier --
// cache, suppression, the "never delays exit" guarantee, required-vs-
// available wording, and the notices[] helpers it shares with status.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `spawn` is a named ESM export; vi.spyOn can't redefine it directly (vitest
// ESM limitation), so it's swapped at mock time instead, the same pattern
// this suite already uses for secret-prompt.js/confirm.js.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
import { spawn } from "node:child_process";
const spawnMock = vi.mocked(spawn);

import {
  highestSeverityNotice,
  isStale,
  isSuppressed,
  maybeNotifyUpdate,
  newer,
  noticeAnnouncementLine,
  noticeLine,
  performRefresh,
  readUpdateCheckCache,
  spawnBackgroundRefresh,
  updateCheckFilePath,
  UPDATE_CHECK_FILE_ENV,
  NO_UPDATE_NOTIFIER_ENV,
  UPDATE_CHECK_INTERVAL_MS,
  type CliNotice,
} from "../src/update-notifier.js";
import { CLI_NAME, CLI_VERSION } from "../src/version.js";

describe("newer()", () => {
  it("compares major.minor.patch numerically", () => {
    expect(newer("0.20.0", "0.19.0")).toBe(true);
    expect(newer("0.19.0", "0.20.0")).toBe(false);
    expect(newer("0.19.0", "0.19.0")).toBe(false);
    expect(newer("1.0.0", "0.19.9")).toBe(true);
    expect(newer("0.19.10", "0.19.9")).toBe(true);
  });

  it("ignores a prerelease/build suffix", () => {
    expect(newer("0.20.0-beta.1", "0.19.0")).toBe(true);
  });
});

describe("updateCheckFilePath()", () => {
  const original = process.env[UPDATE_CHECK_FILE_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[UPDATE_CHECK_FILE_ENV];
    else process.env[UPDATE_CHECK_FILE_ENV] = original;
  });

  it("defaults to ~/.ahood/update-check.json", () => {
    delete process.env[UPDATE_CHECK_FILE_ENV];
    expect(updateCheckFilePath({})).toMatch(/\.ahood[\\/]update-check\.json$/);
  });

  it("respects the env override, like installed.ts's AHOOD_INSTALLED_FILE", () => {
    expect(updateCheckFilePath({ [UPDATE_CHECK_FILE_ENV]: "/tmp/custom.json" })).toBe("/tmp/custom.json");
  });
});

describe("readUpdateCheckCache()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-update-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", () => {
    expect(readUpdateCheckCache(join(dir, "missing.json"))).toBeNull();
  });

  it("returns null (never throws) on corrupted JSON -- a passive notifier must not break a command", () => {
    const path = join(dir, "cache.json");
    writeFileSync(path, "{not json");
    expect(readUpdateCheckCache(path)).toBeNull();
  });

  it("returns null when checked_at is missing or not a string", () => {
    const path = join(dir, "cache.json");
    writeFileSync(path, JSON.stringify({ latest: "1.0.0" }));
    expect(readUpdateCheckCache(path)).toBeNull();
  });

  it("reads a valid cache, with latest defaulting to null when absent/non-string", () => {
    const path = join(dir, "cache.json");
    writeFileSync(path, JSON.stringify({ checked_at: "2026-01-01T00:00:00.000Z", latest: "0.20.0" }));
    expect(readUpdateCheckCache(path)).toEqual({ checked_at: "2026-01-01T00:00:00.000Z", latest: "0.20.0" });
    writeFileSync(path, JSON.stringify({ checked_at: "2026-01-01T00:00:00.000Z" }));
    expect(readUpdateCheckCache(path)).toEqual({ checked_at: "2026-01-01T00:00:00.000Z", latest: null });
  });
});

describe("isStale()", () => {
  it("is stale when there is no cache", () => {
    expect(isStale(null)).toBe(true);
  });

  it("is stale when checked_at cannot be parsed", () => {
    expect(isStale({ checked_at: "not a date", latest: null })).toBe(true);
  });

  it("is fresh just under 24h, stale at exactly 24h", () => {
    const checkedAt = "2026-06-01T00:00:00.000Z";
    const checkedAtMs = Date.parse(checkedAt);
    expect(isStale({ checked_at: checkedAt, latest: null }, checkedAtMs)).toBe(false);
    expect(isStale({ checked_at: checkedAt, latest: null }, checkedAtMs + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(isStale({ checked_at: checkedAt, latest: null }, checkedAtMs + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });
});

describe("performRefresh()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-update-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("writes {checked_at, latest} on a successful npm response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "0.20.0" }), { status: 200 })));
    const path = join(dir, "cache.json");
    await performRefresh(path, 1000);
    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.latest).toBe("0.20.0");
    expect(typeof written.checked_at).toBe("string");
  });

  it("writes latest: null (never throws) when npm is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const path = join(dir, "cache.json");
    await expect(performRefresh(path, 1000)).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf-8")).latest).toBeNull();
  });

  it("writes latest: null when npm answers non-OK or a malformed body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const path = join(dir, "cache.json");
    await performRefresh(path, 1000);
    expect(JSON.parse(readFileSync(path, "utf-8")).latest).toBeNull();
  });
});

describe("spawnBackgroundRefresh()", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("spawns this CLI's own entry file, detached and unref'd, with the hidden refresh subcommand and the cache path", () => {
    const fakeChild = { unref: vi.fn() };
    spawnMock.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    const originalArgv1 = process.argv[1];
    process.argv[1] = "/path/to/dist/index.js";
    try {
      spawnBackgroundRefresh("/tmp/update-check.json");
    } finally {
      process.argv[1] = originalArgv1;
    }
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/path/to/dist/index.js", "__update-check-refresh", "/tmp/update-check.json"],
      { stdio: "ignore", detached: true },
    );
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });

  it("never throws when argv[1] is unavailable or spawn itself fails", () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = undefined as unknown as string;
    expect(() => spawnBackgroundRefresh("/tmp/x.json")).not.toThrow();
    process.argv[1] = originalArgv1;

    spawnMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => spawnBackgroundRefresh("/tmp/x.json")).not.toThrow();
  });
});

describe("isSuppressed()", () => {
  it("suppresses for --json", () => {
    expect(isSuppressed({ json: true, env: {}, isTTY: true })).toBe(true);
  });

  it("suppresses for a non-TTY stderr", () => {
    expect(isSuppressed({ json: false, env: {}, isTTY: false })).toBe(true);
  });

  it("suppresses for CI=1 (and other truthy CI values), not for CI=0 or unset", () => {
    expect(isSuppressed({ json: false, env: { CI: "1" }, isTTY: true })).toBe(true);
    expect(isSuppressed({ json: false, env: { CI: "true" }, isTTY: true })).toBe(true);
    expect(isSuppressed({ json: false, env: { CI: "0" }, isTTY: true })).toBe(false);
    expect(isSuppressed({ json: false, env: {}, isTTY: true })).toBe(false);
  });

  it("suppresses for AHOOD_NO_UPDATE_NOTIFIER=1 only", () => {
    expect(isSuppressed({ json: false, env: { [NO_UPDATE_NOTIFIER_ENV]: "1" }, isTTY: true })).toBe(true);
    expect(isSuppressed({ json: false, env: { [NO_UPDATE_NOTIFIER_ENV]: "0" }, isTTY: true })).toBe(false);
  });

  it("is not suppressed when none of the conditions apply", () => {
    expect(isSuppressed({ json: false, env: {}, isTTY: true })).toBe(false);
  });
});

describe("noticeLine()", () => {
  it("says 'available' when not below minimum", () => {
    const line = noticeLine({ current: "0.19.0", latest: "0.20.0", belowMinimum: false });
    expect(line).toContain(`${CLI_NAME} 0.19.0 → 0.20.0 available`);
    expect(line).toContain(`npx ${CLI_NAME}@latest setup`);
  });

  it("says 'required' when below minimum", () => {
    expect(noticeLine({ current: "0.14.0", latest: "0.20.0", belowMinimum: true })).toContain("required");
  });
});

describe("maybeNotifyUpdate()", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-update-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  function cachePath() {
    return join(dir, "update-check.json");
  }

  it("is synchronous (never returns a Promise) -- structurally, it can never delay a command's exit", () => {
    const result = maybeNotifyUpdate({ json: true });
    expect(result).toBeUndefined();
  });

  it("prints nothing and never touches spawn when suppressed", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    maybeNotifyUpdate({ json: true, env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("prints the available line when the cache has a newer version, and does not touch the network itself", () => {
    writeFileSync(cachePath(), JSON.stringify({ checked_at: new Date().toISOString(), latest: "99.0.0" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    maybeNotifyUpdate({ env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true, cliVersion: "0.1.0" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("0.1.0 → 99.0.0 available");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("prints nothing when the cached latest is not newer than the current version", () => {
    writeFileSync(cachePath(), JSON.stringify({ checked_at: new Date().toISOString(), latest: "0.1.0" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    maybeNotifyUpdate({ env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true, cliVersion: CLI_VERSION });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fires a background refresh (fire-and-forget) when the cache is stale or missing", () => {
    const fakeChild = { unref: vi.fn() };
    spawnMock.mockReturnValue(fakeChild as unknown as ReturnType<typeof spawn>);
    maybeNotifyUpdate({ env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fakeChild.unref).toHaveBeenCalled();
  });

  it("does not refresh when the cache is fresh", () => {
    writeFileSync(cachePath(), JSON.stringify({ checked_at: new Date().toISOString(), latest: "0.1.0" }));
    maybeNotifyUpdate({ env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true, cliVersion: CLI_VERSION });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("prints 'required' wording when belowMinimum is true, using an explicit latest override", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spawnMock.mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
    maybeNotifyUpdate({
      env: { [UPDATE_CHECK_FILE_ENV]: cachePath() },
      isTTY: true,
      cliVersion: "0.14.0",
      belowMinimum: true,
      latest: "0.20.0",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("required");
  });

  it("treats belowMinimum/latest as optional (server hasn't shipped the field yet): absent is a no-op, not a throw", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => maybeNotifyUpdate({ env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true })).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never throws, even if console.error itself throws", () => {
    writeFileSync(cachePath(), JSON.stringify({ checked_at: new Date().toISOString(), latest: "99.0.0" }));
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("terminal gone");
    });
    expect(() => maybeNotifyUpdate({ env: { [UPDATE_CHECK_FILE_ENV]: cachePath() }, isTTY: true, cliVersion: "0.1.0" })).not.toThrow();
  });
});

describe("notices[] helpers (ahood#1554 step 5)", () => {
  const info: CliNotice = { id: "a", kind: "new_feature", severity: "info", message: "low", action: { label: "x", url: "https://x" } };
  const action: CliNotice = { id: "b", kind: "skill_updates", severity: "action", message: "mid", action: { label: "Sync", command: "ahood sync" } };
  const required: CliNotice = {
    id: "c",
    kind: "client_update",
    severity: "required",
    message: "upgrade now",
    action: { label: "Update", command: "npx @ahood/cli@latest setup" },
  };

  it("highestSeverityNotice picks required over action over info", () => {
    expect(highestSeverityNotice([info, action, required])).toBe(required);
    expect(highestSeverityNotice([info, action])).toBe(action);
    expect(highestSeverityNotice([info])).toBe(info);
  });

  it("highestSeverityNotice returns null for an empty or absent list", () => {
    expect(highestSeverityNotice([])).toBeNull();
    expect(highestSeverityNotice(undefined)).toBeNull();
  });

  it("noticeAnnouncementLine includes the message and the suggested (never run) action", () => {
    expect(noticeAnnouncementLine(action)).toContain("mid");
    expect(noticeAnnouncementLine(action)).toContain("ahood sync");
    expect(noticeAnnouncementLine(info)).toContain("https://x");
  });
});
