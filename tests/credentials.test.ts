import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentials, writeCredentials, clearCredentials, resolveToken } from "../src/credentials.js";

describe("credentials file", () => {
  let dir: string;
  const originalHome = process.env.HOME;
  const originalToken = process.env.SKILLHUB_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skillhub-test-"));
    process.env.HOME = dir;
    delete process.env.SKILLHUB_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalToken === undefined) delete process.env.SKILLHUB_TOKEN;
    else process.env.SKILLHUB_TOKEN = originalToken;
  });

  it("returns null when no credentials file exists", () => {
    expect(readCredentials()).toBeNull();
  });

  it("writes and reads back the token", () => {
    writeCredentials({ token: "shk_abc123" });
    expect(readCredentials()).toEqual({ token: "shk_abc123" });
  });

  it("writes the credentials file with mode 0600", () => {
    writeCredentials({ token: "shk_abc123" });
    const stat = statSync(join(dir, ".config", "skillhub", "credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clearCredentials removes the file", () => {
    writeCredentials({ token: "shk_abc123" });
    clearCredentials();
    expect(readCredentials()).toBeNull();
  });

  it("resolveToken prefers SKILLHUB_TOKEN over the credentials file", () => {
    writeCredentials({ token: "shk_from_file" });
    process.env.SKILLHUB_TOKEN = "shk_from_env";
    expect(resolveToken()).toBe("shk_from_env");
  });

  it("resolveToken falls back to the credentials file when SKILLHUB_TOKEN is unset", () => {
    writeCredentials({ token: "shk_from_file" });
    expect(resolveToken()).toBe("shk_from_file");
  });

  it("resolveToken returns null when neither is present", () => {
    expect(resolveToken()).toBeNull();
  });
});
