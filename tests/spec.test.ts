import { describe, expect, it } from "vitest";
import { parseOwnerSkill, parseOwnerSkillVersion, validateSegment, SEMVER_RE } from "../src/spec.js";

const USAGE = "Usage: ahood view <owner>/<skill> [--json] [--web]";

describe("validateSegment", () => {
  it("accepts an ordinary owner/skill segment", () => {
    expect(() => validateSegment("alice", "owner", "alice/demo")).not.toThrow();
    expect(() => validateSegment("demo-skill", "skill", "alice/demo-skill")).not.toThrow();
  });

  it("rejects a malformed segment (bad charset / '..')", () => {
    expect(() => validateSegment("..", "owner", "../demo")).toThrow(/Invalid owner/);
    expect(() => validateSegment("alice!", "owner", "alice!/demo")).toThrow(/Invalid owner/);
  });

  // Owner max length (32) matches the backend's MAX_USERNAME_LENGTH
  // (app/api/v1/profile/route.ts). Skill max length (64) matches the
  // backend's createSkill slug cap (lib/skills/mutations.ts). ahood-cli#38.
  it("accepts an owner segment at exactly the max length (32)", () => {
    const owner = "a".repeat(32);
    expect(() => validateSegment(owner, "owner", `${owner}/demo`)).not.toThrow();
  });

  it("rejects an owner segment one character over the max length", () => {
    const owner = "a".repeat(33);
    expect(() => validateSegment(owner, "owner", `${owner}/demo`)).toThrow(
      /owner segment is too long \(33 characters; must be at most 32\)/,
    );
  });

  it("accepts a skill segment at exactly the max length (64)", () => {
    const skill = "a".repeat(64);
    expect(() => validateSegment(skill, "skill", `alice/${skill}`)).not.toThrow();
  });

  it("rejects a skill segment one character over the max length", () => {
    const skill = "a".repeat(65);
    expect(() => validateSegment(skill, "skill", `alice/${skill}`)).toThrow(
      /skill segment is too long \(65 characters; must be at most 64\)/,
    );
  });

  it("rejects a pathologically long segment (10,000 chars) with a clear, bounded message", () => {
    const huge = "a".repeat(10_000);
    expect(() => validateSegment(huge, "skill", `alice/${huge}`)).toThrow(
      /skill segment is too long \(10000 characters; must be at most 64\)/,
    );
  });
});

describe("parseOwnerSkill", () => {
  it("parses a normal owner/skill spec", () => {
    expect(parseOwnerSkill("alice/demo-skill", USAGE)).toEqual({ owner: "alice", skill: "demo-skill" });
  });

  it("rejects an oversized owner segment", () => {
    const owner = "a".repeat(33);
    expect(() => parseOwnerSkill(`${owner}/demo`, USAGE)).toThrow(/too long/);
  });

  it("rejects an oversized skill segment", () => {
    const skill = "a".repeat(65);
    expect(() => parseOwnerSkill(`alice/${skill}`, USAGE)).toThrow(/too long/);
  });
});

describe("parseOwnerSkillVersion", () => {
  it("parses owner/skill@version", () => {
    expect(parseOwnerSkillVersion("alice/demo@1.2.3", USAGE)).toEqual({
      owner: "alice",
      skill: "demo",
      version: "1.2.3",
    });
  });

  it("defaults to 'latest' with no @version", () => {
    expect(parseOwnerSkillVersion("alice/demo", USAGE)).toEqual({ owner: "alice", skill: "demo", version: "latest" });
  });

  it("rejects an oversized skill segment even with a version suffix", () => {
    const skill = "a".repeat(65);
    expect(() => parseOwnerSkillVersion(`alice/${skill}@1.0.0`, USAGE)).toThrow(/too long/);
  });
});

describe("SEMVER_RE", () => {
  it("matches ordinary semver strings", () => {
    expect(SEMVER_RE.test("1.2.3")).toBe(true);
    expect(SEMVER_RE.test("1.2.3-beta.1")).toBe(true);
  });

  // ahood-cli#40: real semver (semver.org section 2) forbids leading zeros
  // in the major/minor/patch numeric identifiers.
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
