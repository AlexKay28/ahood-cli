// ahood#1553 step 4: this CLI's copy of the provenance header module must
// behave byte-identically to the web's (lib/provenance-header.ts there,
// src/provenance-header.ts here) -- parity-tested against the exact same
// fixture file both repos carry (tests/fixtures/provenance-header-vectors.json),
// read with fs rather than a static import so neither side's JSON parser
// can quietly disagree with the other's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProvenanceHeader, stripProvenanceHeader, type ProvenanceHeaderMeta } from "../src/provenance-header.js";

type Vector =
  | { name: string; op: "build"; input: string; meta: ProvenanceHeaderMeta; expected: string }
  | { name: string; op: "strip"; input: string; expected: string };

const vectors: Vector[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "provenance-header-vectors.json"), "utf8"),
);

const META: ProvenanceHeaderMeta = {
  title: "Demo Skill",
  owner: "alice",
  slug: "demo-skill",
  version: "1.4.0",
  url: "https://www.ahood.dev/alice/demo-skill",
};

describe("provenance-header fixture vectors (parity with the web's copy)", () => {
  it("covers every required case", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });

  for (const vector of vectors) {
    it(`${vector.op}: ${vector.name}`, () => {
      const actual = vector.op === "build" ? buildProvenanceHeader(vector.input, vector.meta) : stripProvenanceHeader(vector.input);
      expect(actual).toBe(vector.expected);
    });
  }
});

describe("buildProvenanceHeader", () => {
  it("places the header at the very top when there is no frontmatter", () => {
    expect(buildProvenanceHeader("# Hello\n", META).startsWith("> **Demo Skill**")).toBe(true);
  });

  it("places the header after the YAML frontmatter block", () => {
    const content = "---\nname: demo-skill\n---\n# Hello\n";
    expect(buildProvenanceHeader(content, META).startsWith("---\nname: demo-skill\n---\n> **Demo Skill**")).toBe(true);
  });

  it("is idempotent: build(build(x)) === build(x)", () => {
    const once = buildProvenanceHeader("# Hello\n", META);
    expect(buildProvenanceHeader(once, META)).toBe(once);
  });

  it("replaces an existing header rather than stacking a second one when the version changes", () => {
    const v1 = buildProvenanceHeader("# Hello\n", META);
    const v2 = buildProvenanceHeader(v1, { ...META, version: "2.0.0" });
    expect(v2.match(/ahood:provenance/g)).toHaveLength(1);
    expect(v2).toContain("v2.0.0");
    expect(v2).not.toContain("v1.4.0");
  });
});

// Hardening pass (issue #1553 follow-up, before the web's own updated
// fixture vectors landed): escaping and frontmatter-edge-case coverage not
// yet in the shared fixture file above. Re-sync tests/fixtures/
// provenance-header-vectors.json from web once it ships these cases, and
// this describe block can likely shrink back to just the parity table.
describe("hardening: escaping and frontmatter edge cases", () => {
  it("turns \\r and \\n in title/owner/slug/version into spaces, so a crafted value can't split the single-line header", () => {
    const result = buildProvenanceHeader("body\n", { ...META, title: "Evil\nTitle\rHere" });
    expect(result.split("\n")[0]).toBe(
      "> **Evil Title Here** · [alice/demo-skill](https://www.ahood.dev/alice/demo-skill) · v1.4.0 · from ahood.dev — check for updates: `ahood status` or /ahood",
    );
  });

  it("backslash-escapes *, [, ], ( and ` so they can't reopen markdown or close the CTA's code span", () => {
    const result = buildProvenanceHeader("body\n", { ...META, title: "a*b[c](d)`e`" });
    expect(result).toContain("a\\*b\\[c\\]\\(d\\)\\`e\\`");
  });

  it("does not escape the url", () => {
    const result = buildProvenanceHeader("body\n", { ...META, url: "https://www.ahood.dev/alice/demo-skill?x=(1)" });
    expect(result).toContain("(https://www.ahood.dev/alice/demo-skill?x=(1))");
  });

  it("places the header after an EMPTY frontmatter block (---\\n---\\n)", () => {
    const result = buildProvenanceHeader("---\n---\n# Body\n", META);
    expect(result.startsWith("---\n---\n> **Demo Skill**")).toBe(true);
    expect(result).toContain("# Body\n");
  });

  it("places the header after frontmatter with no trailing EOL at all (---\\nname: x\\n---)", () => {
    const result = buildProvenanceHeader("---\nname: x\n---", META);
    expect(result.startsWith("---\nname: x\n---\n> **Demo Skill**")).toBe(true);
  });

  it("round-trips the empty-frontmatter shape exactly", () => {
    const content = "---\n---\n# Body\n";
    expect(stripProvenanceHeader(buildProvenanceHeader(content, META))).toBe(content);
  });

  it("round-trips the no-trailing-EOL shape up to the EOL build() had to add (documented: not byte-exact on this one malformed-input shape)", () => {
    const content = "---\nname: x\n---";
    expect(stripProvenanceHeader(buildProvenanceHeader(content, META))).toBe(`${content}\n`);
  });
});

describe("stripProvenanceHeader", () => {
  it("is a no-op on content with no header", () => {
    const content = "# Hello\n\nBody.\n";
    expect(stripProvenanceHeader(content)).toBe(content);
  });

  it("round-trips a fresh build back to the original content", () => {
    const content = "---\nname: demo-skill\n---\n# Hello\n\nBody.\n";
    expect(stripProvenanceHeader(buildProvenanceHeader(content, META))).toBe(content);
  });

  it("leaves a look-alike marker elsewhere in user content untouched", () => {
    const content = "# Hello\n\nA user wrote this exact line:\n<!-- ahood:provenance v=1 ref=evil/thing@9.9.9 -->\nMore text.\n";
    expect(stripProvenanceHeader(content)).toBe(content);
  });
});
