#!/usr/bin/env node
// Moves the `release` branch -- the stable channel Claude Code and Codex read
// the ahood plugin from (ahood#1018 step B) -- to the commit being released.
// The release workflow runs it after both npm publishes succeeded.
//
//   - no `release` on the remote yet: the push creates it (the first release
//     after step B);
//   - `release` already contains the commit (a re-run, or a re-run of an
//     older tag): nothing to do;
//   - otherwise a plain `git push <sha>:refs/heads/release` -- never forced,
//     so anything but a fast-forward is refused by git and fails the job.
//
// Usage:
//   node scripts/release-branch.mjs [commit] [remote]   # default: HEAD, origin

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_BRANCH = "release";

const git = (cwd, args, opts = {}) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "inherit"] }).trim();

/** Returns what happened: "created", "unchanged" or "fast-forwarded"; throws when git refuses the push. */
export function moveReleaseBranch({ cwd = process.cwd(), commit = "HEAD", remote = "origin" } = {}) {
  const sha = git(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  const ref = `refs/heads/${RELEASE_BRANCH}`;
  const current = git(cwd, ["ls-remote", remote, ref]).split(/\s+/)[0] || null;
  if (current !== null) {
    git(cwd, ["fetch", "--quiet", remote, ref], { quiet: true });
    let contained = true;
    try {
      git(cwd, ["merge-base", "--is-ancestor", sha, "FETCH_HEAD"], { quiet: true });
    } catch {
      contained = false;
    }
    if (contained) return { action: "unchanged", sha, previous: current };
  }
  git(cwd, ["push", remote, `${sha}:${ref}`]);
  return { action: current === null ? "created" : "fast-forwarded", sha, previous: current };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commit, remote] = process.argv.slice(2);
  try {
    const { action, sha, previous } = moveReleaseBranch({ commit, remote });
    const what = { created: "created at", unchanged: "already contains", "fast-forwarded": `fast-forwarded from ${previous} to` }[action];
    console.log(`${RELEASE_BRANCH}: ${what} ${sha}`);
  } catch (error) {
    console.error(`Could not move ${RELEASE_BRANCH}: ${error instanceof Error ? error.message : String(error)}`);
    console.error("It is only ever fast-forwarded: a tag whose commit does not descend from the branch needs a person to look.");
    process.exit(1);
  }
}
