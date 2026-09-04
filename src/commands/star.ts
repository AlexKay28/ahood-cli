import { apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";

type StarResponse = { starred: boolean };

// Mirrors POST/DELETE /api/v1/skills/{owner}/{skill}/star -- both are
// idempotent server-side (POST upserts on the stars table's
// unique(skill_id, user_id) constraint with ignoreDuplicates, DELETE just
// deletes any matching row), so starring an already-starred skill or
// unstarring one you never starred is a no-op 200, not an error.
export async function star(args: string[]): Promise<void> {
  const USAGE = "Usage: ahood skill star <owner>/<skill>";
  const { owner, skill } = parseOwnerSkill(args[0] ?? "", USAGE);

  await apiJson<StarResponse>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/star`, {
    method: "POST",
  });
  console.log(`Starred ${owner}/${skill}.`);
}

export async function unstar(args: string[]): Promise<void> {
  const USAGE = "Usage: ahood skill unstar <owner>/<skill>";
  const { owner, skill } = parseOwnerSkill(args[0] ?? "", USAGE);

  await apiJson<StarResponse>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/star`, {
    method: "DELETE",
  });
  console.log(`Unstarred ${owner}/${skill}.`);
}
