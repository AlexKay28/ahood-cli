// ahood#990 decision C: one self-skill source. src/skill/using-ahood.md is
// the canonical body; scripts/sync-skill.mjs renders it (with its own
// frontmatter) into every place that teaches the same thing. This is the
// drift guard -- it fails the moment an on-disk generated file stops
// matching what the generator renders, the same pattern
// tests/ahood-commands-parity.test.ts already uses for the Claude plugin's
// /ahood command files.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalBody, renderPluginSkill, targets, CANONICAL_PATH } from "../scripts/sync-skill.mjs";

const ROOT = join(import.meta.dirname, "..");

describe("the self-skill's generated files match scripts/sync-skill.mjs (run `npm run sync-skill` if this fails)", () => {
  it("every target this repo has on disk is byte-identical to what the generator renders", () => {
    const rendered = targets();
    // Guards against the whole test silently passing on zero targets if a
    // future repo layout change ever made every target's directory vanish.
    expect(rendered.length).toBeGreaterThan(0);
    for (const { path, render } of rendered) {
      expect(readFileSync(join(ROOT, path), "utf8")).toBe(render());
    }
  });

  it("plugins/ahood/skills/using-ahood/SKILL.md is one of the generated targets", () => {
    expect(targets().map((t) => t.path)).toContain("plugins/ahood/skills/using-ahood/SKILL.md");
  });

  it("so is the Codex plugin's copy, plugins/codex/skills/using-ahood/SKILL.md (ahood#1009)", () => {
    expect(targets().map((t) => t.path)).toContain("plugins/codex/skills/using-ahood/SKILL.md");
  });
});

describe("the canonical self-skill body (src/skill/using-ahood.md)", () => {
  const body = canonicalBody();

  it("exists and is non-empty", () => {
    expect(existsSync(join(ROOT, CANONICAL_PATH))).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("carries the front-door message", () => {
    expect(body).toContain("npx @ahood/cli@latest setup");
    expect(body).toMatch(/\/ahood/);
  });

  it("carries the snap capture moments, the privacy note, and the never-auto-sync rule", () => {
    expect(body).toContain("right after you hand over a deliverable, and right after the\nuser corrects you");
    expect(body).toContain("Snaps are private to you");
    expect(body).toContain("Never save a snap the user has not seen");
    expect(body).toContain("Never sync on your own.");
  });

  it("names the token as AHOOD_TOKEN, not the old AHOOD_API_TOKEN as primary", () => {
    expect(body).toMatch(/`AHOOD_TOKEN`/);
  });
});

describe("renderPluginSkill()", () => {
  it("has its own name and description, over the shared canonical body", () => {
    const plugin = renderPluginSkill();
    expect(plugin).toMatch(/^---\nname: using-ahood\n/);
    expect(plugin.endsWith(canonicalBody())).toBe(true);
  });

  it("is the only kind of target: no registry copy, no `ahood help useme` file (ahood#1018)", () => {
    for (const { path } of targets()) expect(path).toMatch(/^plugins\/[a-z]+\/skills\/using-ahood\/SKILL\.md$/);
  });
});
