import { apiJson } from "../http.js";
import { parseArgs } from "../flags.js";
import { parseOwnerSkill, validateExternalUrl } from "../spec.js";
import { UsageError } from "../usage-error.js";
import { ensureRemoteKind, type KindScope } from "../kinds.js";
import { usageLine } from "../help.js";

type UpdateResponse = {
  slug: string;
  tagline: string | null;
  license: string | null;
  visibility: string;
  tags: string[];
  homepage?: string | null;
  repository?: string | null;
  // updateSkill (lib/skills/mutations.ts) still returns ok:true when the
  // update itself succeeded but a follow-up step involving tags failed --
  // it attaches this field instead of failing the whole request. Discarding
  // it would silently drop that signal, same class of bug as ahood-cli#68's
  // latest_version_warning on yank.
  tags_warning?: string;
};


// Mirrors PATCH /api/v1/skills/{owner}/{skill}'s allow-list exactly
// (lib/skills/mutations.ts's UpdateSkillInput) -- only a field the caller
// explicitly passed a flag for is included in the body, so an omitted flag
// never clobbers an existing value (the route only validates/writes keys
// that are present on the body at all).
export async function edit(args: string[], scope?: KindScope): Promise<void> {
  const USAGE = usageLine(scope?.noun ?? "skill", "edit");
  // An undeclared flag is refused rather than dropped: `--visiblity public`
  // next to a valid --tagline used to PATCH the tagline alone and exit 0, so
  // the skill stayed private with nothing to say so (ahood-cli#260). --json is
  // tolerated, not implemented (ahood-cli#251).
  const parsed = parseArgs(args, {
    usage: USAGE,
    booleans: ["--json"],
    values: ["--tagline", "--tags", "--license", "--visibility", "--homepage", "--repository"],
    min: 1,
    max: 1,
  });
  const { owner, skill } = parseOwnerSkill(parsed.positionals[0], USAGE);

  const body: Record<string, unknown> = {};
  const tagline = parsed.value("--tagline");
  if (tagline !== undefined) body.tagline = tagline;
  const tags = parsed.value("--tags");
  if (tags !== undefined) body.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
  const license = parsed.value("--license");
  if (license !== undefined) body.license = license;
  const visibility = parsed.value("--visibility");
  if (visibility !== undefined) {
    if (visibility !== "public" && visibility !== "private") {
      throw new UsageError(`--visibility must be "public" or "private" (got "${visibility}").`);
    }
    body.visibility = visibility;
  }
  const homepage = parsed.value("--homepage");
  if (homepage !== undefined) {
    validateExternalUrl(homepage, "--homepage");
    body.homepage = homepage;
  }
  const repository = parsed.value("--repository");
  if (repository !== undefined) {
    validateExternalUrl(repository, "--repository");
    body.repository = repository;
  }

  if (Object.keys(body).length === 0) {
    throw new UsageError(
      "Nothing to update -- pass at least one of --tagline, --tags, --license, --visibility, --homepage, --repository.",
    );
  }

  await ensureRemoteKind(scope, owner, skill, "edit", "edit");
  const updated = await apiJson<UpdateResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  console.log(`Updated ${owner}/${updated.slug}: tagline=${JSON.stringify(updated.tagline)}, license=${JSON.stringify(updated.license)}, visibility=${updated.visibility}, tags=[${updated.tags.join(", ")}]`);
  if (updated.tags_warning) {
    console.warn(`WARNING: ${updated.tags_warning}`);
  }
}
