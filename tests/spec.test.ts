import { describe, expect, it } from "vitest";
import { SEMVER_RE } from "../src/spec.js";

describe("SEMVER_RE", () => {
  it("rejects leading zeros in the major/minor/patch numeric identifiers", () => {
    expect(SEMVER_RE.test("01.0.1")).toBe(false);
    expect(SEMVER_RE.test("1.00.1")).toBe(false);
    expect(SEMVER_RE.test("1.0.01")).toBe(false);
  });

  it("still accepts spec-compliant versions", () => {
    expect(SEMVER_RE.test("1.0.0")).toBe(true);
    expect(SEMVER_RE.test("10.0.0")).toBe(true);
    expect(SEMVER_RE.test("0.0.0")).toBe(true);
  });

  it("still accepts a leading-zero-looking pre-release identifier (semver allows this)", () => {
    expect(SEMVER_RE.test("1.0.0-beta.01")).toBe(true);
  });
});
