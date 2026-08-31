import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";
import { parseOwnerSkill } from "../spec.js";

type UpdateResponse = {
  slug: string;
  tagline: string | null;
  license: string | null;
  visibility: string;
  tags: string[];
  homepage?: string | null;
  repository?: string | null;
};

const USAGE =
  "Usage: ahood edit <owner>/<skill> [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--visibility public|private] [--homepage <url>] [--repository <url>]";

// Mirrors PATCH /api/v1/skills/{owner}/{skill}'s allow-list exactly
// (lib/skills/mutations.ts's UpdateSkillInput) -- only a field the caller
// explicitly passed a flag for is included in the body, so an omitted flag
// never clobbers an existing value (the route only validates/writes keys
// that are present on the body at all).
export async function edit(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec || spec.startsWith("--")) throw new Error(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const body: Record<string, unknown> = {};
  const tagline = flagValue(args, "--tagline");
  if (tagline !== undefined) body.tagline = tagline;
  const tags = flagValue(args, "--tags");
  if (tags !== undefined) body.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
  const license = flagValue(args, "--license");
  if (license !== undefined) body.license = license;
  const visibility = flagValue(args, "--visibility");
  if (visibility !== undefined) {
    if (visibility !== "public" && visibility !== "private") {
      throw new Error(`--visibility must be "public" or "private" (got "${visibility}").`);
    }
    body.visibility = visibility;
  }
  const homepage = flagValue(args, "--homepage");
  if (homepage !== undefined) body.homepage = homepage;
  const repository = flagValue(args, "--repository");
  if (repository !== undefined) body.repository = repository;

  if (Object.keys(body).length === 0) {
    throw new Error(
      "Nothing to update -- pass at least one of --tagline, --tags, --license, --visibility, --homepage, --repository.",
    );
  }

  const updated = await apiJson<UpdateResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  console.log(`Updated ${owner}/${updated.slug}: tagline=${JSON.stringify(updated.tagline)}, license=${JSON.stringify(updated.license)}, visibility=${updated.visibility}, tags=[${updated.tags.join(", ")}]`);
}
