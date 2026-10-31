// The stable channel every host reads the ahood plugin from (ahood#1018 step
// B): the `release` branch of AlexKay28/ahood-cli, which the release workflow
// fast-forwards to each release tag's commit after both npm publishes
// succeed. A commit on `main` without a release reaches no one; every release
// reaches everyone whose host tracks the branch.
//
// The branch only exists once the first release after ahood#1018 step B has
// run, and both hosts fail on a ref the remote does not have (verified:
// claude 2.1.282 `plugin marketplace add AlexKay28/ahood-cli#release` -> "Remote
// branch release not found in upstream origin"; codex-cli 0.165.0 `plugin
// marketplace upgrade` -> "git ls-remote returned empty output"). So setup
// and doctor ask GitHub first, the way `git ls-remote` would.

export const RELEASE_REPO = "AlexKay28/ahood-cli";
export const RELEASE_BRANCH = "release";

/** GitHub's smart-HTTP ref advertisement: what `git ls-remote` reads, no API rate limit, no auth for a public repo. */
export const RELEASE_REFS_URL = `https://github.com/${RELEASE_REPO}.git/info/refs?service=git-upload-pack`;

const PROBE_TIMEOUT_MS = 5_000;

/** True when the remote has the branch, false when it does not, null when GitHub could not be asked. */
export type ReleaseBranchProbe = () => Promise<boolean | null>;

/** Each advertised ref is `<sha> refs/heads/<name>`, ended by a newline or (the first one) a NUL before the capabilities. */
export function advertisesBranch(advertisement: string, branch: string): boolean {
  return new RegExp(`[0-9a-f]{40} refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|\\0)`).test(advertisement);
}

const realProbe: ReleaseBranchProbe = async () => {
  try {
    const response = await fetch(RELEASE_REFS_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    return advertisesBranch(await response.text(), RELEASE_BRANCH);
  } catch {
    return null;
  }
};

let current: ReleaseBranchProbe = realProbe;

export function releaseBranchExists(): Promise<boolean | null> {
  return current();
}

/** Tests only: swap the probe; returns a restore function. */
export function setReleaseProbeForTests(next: ReleaseBranchProbe): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}

/** Why setup stops while the branch is missing, and what the user (or the owner) does next. */
export function releaseBranchMissing(host: string): string {
  return (
    `the \`${RELEASE_BRANCH}\` branch of ${RELEASE_REPO} does not exist yet, so ${host} has nothing to install from. ` +
    "It is created by the next ahood-cli release (the release workflow fast-forwards it to the release tag). " +
    "Nothing was changed; re-run this after that release."
  );
}
