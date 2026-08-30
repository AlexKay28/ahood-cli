import { apiJson } from "../http.js";

type UpdateResponse = { slug: string; tagline: string | null; license: string | null; visibility: string; tags: string[] };

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// Mirrors PATCH /api/v1/skills/{owner}/{skill}'s allow-list exactly
// (lib/skills/mutations.ts's UpdateSkillInput) -- only a field the caller
// explicitly passed a flag for is included in the body, so an omitted flag
// never clobbers an existing value (the route only validates/writes keys
// that are present on the body at all).
export async function edit(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec || spec.startsWith("--")) {
    throw new Error(
      "Usage: ahood edit <owner>/<skill> [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--visibility public|private]",
    );
  }
  const [owner, skill] = spec.split("/");
  if (!owner || !skill) throw new Error("Usage: ahood edit <owner>/<skill> [--tagline ...] [--tags ...] [--license ...] [--visibility ...]");

  const body: Record<string, unknown> = {};
  const tagline = flagValue(args, "--tagline");
  if (tagline !== undefined) body.tagline = tagline;
  const tags = flagValue(args, "--tags");
  if (tags !== undefined) body.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
  const license = flagValue(args, "--license");
  if (license !== undefined) body.license = license;
  const visibility = flagValue(args, "--visibility");
  if (visibility !== undefined) body.visibility = visibility;

  if (Object.keys(body).length === 0) {
    throw new Error("Nothing to update -- pass at least one of --tagline, --tags, --license, --visibility.");
  }

  const updated = await apiJson<UpdateResponse>(`/api/v1/skills/${owner}/${skill}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log(`Updated ${owner}/${updated.slug}: tagline=${JSON.stringify(updated.tagline)}, license=${JSON.stringify(updated.license)}, visibility=${updated.visibility}, tags=[${updated.tags.join(", ")}]`);
}
