// ahood#1018 step B: after both npm publishes, the release workflow moves the
// `release` branch (the channel Claude Code and Codex install from) to the
// tag's commit: created on the first run, never forced, a no-op on a re-run.
// Exercised against a real bare git remote in a temp dir.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- a plain .mjs script, no type declarations
import { moveReleaseBranch } from "../scripts/release-branch.mjs";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "release-branch.mjs");
const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf-8");

let dir: string;
let work: string;
let remote: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const commit = (msg: string) => {
  writeFileSync(join(work, "f.txt"), msg);
  git(work, "add", "f.txt");
  git(work, "commit", "-q", "-m", msg);
  return git(work, "rev-parse", "HEAD");
};
const remoteRelease = () => git(remote, "rev-parse", "refs/heads/release");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ahood-release-branch-"));
  remote = join(dir, "remote.git");
  work = join(dir, "work");
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "init", "-q", work);
  git(work, "remote", "add", "origin", remote);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("scripts/release-branch.mjs", () => {
  it("creates the branch on the first release, then fast-forwards it", () => {
    const v1 = commit("v1");
    git(work, "push", "-q", "origin", "main");
    expect(moveReleaseBranch({ cwd: work })).toMatchObject({ action: "created", sha: v1 });
    expect(remoteRelease()).toBe(v1);
    commit("unreleased");
    const v2 = commit("v2");
    git(work, "push", "-q", "origin", "main");
    expect(moveReleaseBranch({ cwd: work })).toMatchObject({ action: "fast-forwarded", sha: v2, previous: v1 });
    expect(remoteRelease()).toBe(v2);
  });

  it("leaves the branch alone when it already contains the commit (a re-run, or an older tag)", () => {
    const v1 = commit("v1");
    const v2 = commit("v2");
    git(work, "push", "-q", "origin", "main");
    moveReleaseBranch({ cwd: work, commit: v2 });
    expect(moveReleaseBranch({ cwd: work, commit: v2 })).toMatchObject({ action: "unchanged" });
    expect(moveReleaseBranch({ cwd: work, commit: v1 })).toMatchObject({ action: "unchanged" });
    expect(remoteRelease()).toBe(v2);
  });

  it("never forces: a commit that does not descend from the branch fails (exit 1) and the branch stays", () => {
    const base = commit("base");
    const v1 = commit("v1");
    git(work, "push", "-q", "origin", "main");
    moveReleaseBranch({ cwd: work, commit: v1 });
    git(work, "checkout", "-q", "-b", "side", base);
    const side = commit("side");
    git(work, "push", "-q", "origin", "side");
    const result = spawnSync(process.execPath, [SCRIPT, side], { cwd: work, encoding: "utf-8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not move release");
    expect(remoteRelease()).toBe(v1);
  });
});

describe("release.yml moves the release branch (ahood#1018 step B)", () => {
  const steps = releaseYml.split("\n      - ").map((s) => s.trim());
  const index = (needle: string) => steps.findIndex((s) => s.includes(needle));

  it("runs the script as the last step, after both npm publishes", () => {
    const move = index("node scripts/release-branch.mjs");
    expect(move).toBe(steps.length - 1);
    expect(index("run: npm publish\n")).toBeLessThan(move);
    expect(index("npm publish --access public")).toBeLessThan(move);
  });

  it("has contents: write, full history, and no force anywhere", () => {
    expect(releaseYml).toMatch(/permissions:\n\s+# [^\n]*\n\s+contents: write/);
    expect(releaseYml).toContain("fetch-depth: 0");
    expect(releaseYml).not.toMatch(/--force|\s-f\s|\+refs|:refs\/heads\/release.*\+/);
    expect(readFileSync(SCRIPT, "utf-8")).not.toMatch(/--force|"-f"|"\+/);
  });
});
