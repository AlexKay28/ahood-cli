import { createInterface } from "node:readline";
import { apiJson } from "../http.js";
import { parseOwnerSkill, parseOwnerSkillVersion } from "../spec.js";

const USAGE = "Usage: ahood unpublish <owner>/<skill>[@version] [--yes]";

// On closed/non-interactive stdin, readline/promises' rl.question() promise
// never settles -- but since nothing else keeps the event loop alive at that
// point, the process used to exit 0 anyway once the loop drained, having
// printed only the prompt (no "Aborted.", no deletion, no error: a silent
// false success). The plain callback-style API is used instead specifically
// so the "close" listener can be a reliable signal for "closed without ever
// answering": `settled` is set synchronously inside the answer callback,
// before rl.close() is called, so that same close doesn't self-reject.
function confirm(promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let settled = false;
    rl.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Confirmation was not answered (stdin closed)."));
    });
    rl.question(promptText, (answer) => {
      settled = true;
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

// A bare "owner/skill" has no "@" at all, so lastIndexOf("@") is -1 and this
// is a whole-skill unpublish (preserves the exact pre-existing behavior).
// "owner/skill@1.2.3" has an "@" at index > 0 and is a single-version yank
// instead -- parseOwnerSkillVersion is reused rather than re-parsing "@" by
// hand, so the same version-format validation (spec.ts's SEMVER_RE / the
// "latest" literal) applies here as it already does for `add`/`view`.
function isVersioned(spec: string): boolean {
  return spec.lastIndexOf("@") > 0;
}

export async function unpublish(args: string[]): Promise<void> {
  const yes = args.includes("--yes");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new Error(USAGE);

  if (isVersioned(spec)) {
    const { owner, skill, version } = parseOwnerSkillVersion(spec, USAGE);
    const key = `${owner}/${skill}@${version}`;

    // Yanking is less destructive than a whole-skill delete (existing
    // lockfile-pinned installs keep resolving/verifying against it -- see
    // add.ts's yanked_at warning), so the prompt wording says so instead of
    // reusing the whole-skill "permanently delete ... for everyone" text,
    // which would overstate what actually happens here.
    const confirmed = yes
      ? true
      : await confirm(
          `Yank ${key}? Existing installs keep working; new installs will be warned. Type "yes" to confirm: `,
        );

    if (!confirmed) {
      console.log("Aborted.");
      return;
    }

    // DELETE on the version resource itself (no separate /yank sub-route):
    // the server treats this the same way whole-skill DELETE already does
    // (a soft delete that sets a timestamp column, never removes the row),
    // just scoped one level down to skill_versions.yanked_at/yanked_reason
    // instead of skills.deleted_at. Mirroring that existing verb/path
    // convention rather than inventing a new one.
    await apiJson(
      `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions/${encodeURIComponent(version)}`,
      { method: "DELETE" },
    );
    console.log(`Yanked ${key}. Existing lockfile pins still resolve; new installs will be warned off it.`);
    return;
  }

  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  const key = `${owner}/${skill}`;

  // --yes bypasses the prompt for scripts/CI; otherwise a closed stdin (no
  // TTY, no piped answer either) now throws via confirm()'s "close" handling
  // instead of silently exiting 0 with nothing prompted, confirmed, or done.
  const confirmed = yes
    ? true
    : await confirm(`This will permanently delete ${key} for everyone who has installed it. Type "yes" to confirm: `);

  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`, { method: "DELETE" });
  console.log(`Unpublished ${key}. Run \`ahood remove ${key}\` to also remove your local copy.`);
}
