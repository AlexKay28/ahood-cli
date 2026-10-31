// ahood#1018 step E: every release has a section in the Claude plugin's
// changelog. scripts/check-changelog.mjs is the one rule; `npm version`'s
// preversion hook (with the new version, before any file changes) and the
// release workflow (before publishing) both run it.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- a plain .mjs script, no type declarations
import { hasSection } from "../scripts/check-changelog.mjs";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-changelog.mjs");
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf-8");
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });

function scratch(changelog: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "ahood-changelog-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ahood/cli", version: "1.2.3" }));
  if (changelog !== null) {
    mkdirSync(join(dir, "plugins", "ahood"), { recursive: true });
    writeFileSync(join(dir, "plugins", "ahood", "CHANGELOG.md"), changelog);
  }
  return dir;
}

describe("plugins/ahood/CHANGELOG.md (ahood#1018 step E)", () => {
  it("has a section for this repo's current version", () => {
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("matches `## <version>` headings only, with anything after a space", () => {
    expect(hasSection("# Changelog\n\n## 1.2.3 (2026-11-01)\n", "1.2.3")).toBe(true);
    expect(hasSection("## 1.2.3\n", "1.2.3")).toBe(true);
    expect(hasSection("## 1.2.30\n", "1.2.3")).toBe(false);
    expect(hasSection("## 1x2x3\n", "1.2.3")).toBe(false);
    expect(hasSection("### 1.2.3\n", "1.2.3")).toBe(false);
    expect(hasSection("- fixed in 1.2.3\n", "1.2.3")).toBe(false);
  });

  for (const [label, changelog, needle] of [
    ["has no section for the version", "# Changelog\n\n## 1.2.2\n", 'no "## 1.2.3" section'],
    ["is missing", null, "is missing"],
  ] as const) {
    it(`fails (exit 1) when the changelog ${label}`, () => {
      const dir = scratch(changelog);
      try {
        const result = run("", dir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(needle);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("checks the version it is given (npm's $npm_new_version) over package.json's", () => {
    const dir = scratch("## 1.2.3\n");
    try {
      expect(run("1.3.0", dir).status).toBe(1);
      expect(run("1.2.3", dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("npm version's preversion hook runs it with the new version", () => {
    expect(rootPkg.scripts.preversion).toBe('node scripts/check-changelog.mjs "$npm_new_version"');
  });

  it("release.yml runs it, and `claude plugin validate --strict` on the marketplace and plugin, before publishing", () => {
    const at = (needle: string) => releaseYml.indexOf(needle);
    const firstPublish = at("run: npm publish");
    expect(firstPublish).toBeGreaterThan(0);
    for (const step of [
      "run: node scripts/check-changelog.mjs",
      "plugin validate --strict .\n",
      "plugin validate --strict plugins/ahood\n",
    ]) {
      expect(at(step)).toBeGreaterThan(0);
      expect(at(step)).toBeLessThan(firstPublish);
    }
    expect(releaseYml).toMatch(/npx -y @anthropic-ai\/claude-code@\d+\.\d+\.\d+ plugin validate/);
  });
});
