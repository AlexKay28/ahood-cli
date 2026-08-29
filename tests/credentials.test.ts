import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials, writeCredentials, clearCredentials, resolveToken } from "../src/credentials.js";

describe("credentials file", () => {
  let dir: string;
  const originalHome = process.env.HOME;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-test-"));
    process.env.HOME = dir;
    delete process.env.AHOOD_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("returns null when no credentials file exists", () => {
    expect(readCredentials()).toBeNull();
  });

  it("writes and reads back the token", () => {
    writeCredentials({ token: "ahd_abc123" });
    expect(readCredentials()).toEqual({ token: "ahd_abc123" });
  });

  it("writes the credentials file with mode 0600", () => {
    writeCredentials({ token: "ahd_abc123" });
    const stat = statSync(join(dir, ".config", "ahood", "credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("restores 0600 even when a pre-existing file has looser permissions", () => {
    const ahoodDir = join(dir, ".config", "ahood");
    mkdirSync(ahoodDir, { recursive: true, mode: 0o755 });
    const path = join(ahoodDir, "credentials.json");
    writeFileSync(path, JSON.stringify({ token: "ahd_old" }), { mode: 0o644 });
    // Sanity-check the fixture actually starts out loose -- writeFileSync's
    // mode option only applies at creation, so this should be 0644 here.
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeCredentials({ token: "ahd_new" });

    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clearCredentials removes the file", () => {
    writeCredentials({ token: "ahd_abc123" });
    clearCredentials();
    expect(readCredentials()).toBeNull();
  });

  it("resolveToken prefers AHOOD_TOKEN over the credentials file", () => {
    writeCredentials({ token: "ahd_from_file" });
    process.env.AHOOD_TOKEN = "ahd_from_env";
    expect(resolveToken()).toBe("ahd_from_env");
  });

  it("resolveToken falls back to the credentials file when AHOOD_TOKEN is unset", () => {
    writeCredentials({ token: "ahd_from_file" });
    expect(resolveToken()).toBe("ahd_from_file");
  });

  it("resolveToken returns null when neither is present", () => {
    expect(resolveToken()).toBeNull();
  });
});
