import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";
import { parseOwnerSkill } from "../spec.js";

// These are skill-entity verbs (reached as `ahood skill share`/`ahood skill
// unshare`, registered in SKILL_COMMANDS in index.ts), not group verbs --
// they mutate a skill's sharing, not a group. Grouped together in one file
// the same way star.ts groups its own paired verbs (star/unstar).
const SHARE_USAGE = "Usage: ahood skill share <owner>/<skill> --group <group>";
const UNSHARE_USAGE = "Usage: ahood skill unshare <owner>/<skill> --group <group>";

type ShareResponse = { shared: boolean };

// Owner-of-the-skill-only server-side, and the caller must already be a
// member of the target group -- both enforced by the API, not re-checked
// here. Follows edit.ts's convention of requiring the owner/skill spec
// first (before any flags), since --group takes a value and a "first
// non---flag token" scan would misidentify the --group value as the spec
// if --group happened to come first.
export async function share(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec || spec.startsWith("--")) throw new Error(SHARE_USAGE);
  const { owner, skill } = parseOwnerSkill(spec, SHARE_USAGE);
  const groupSlug = flagValue(args, "--group");
  if (!groupSlug) throw new Error(SHARE_USAGE);

  await apiJson<ShareResponse>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_slug: groupSlug }),
  });
  console.log(`Shared ${owner}/${skill} with ${groupSlug}.`);
}

export async function unshare(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec || spec.startsWith("--")) throw new Error(UNSHARE_USAGE);
  const { owner, skill } = parseOwnerSkill(spec, UNSHARE_USAGE);
  const groupSlug = flagValue(args, "--group");
  if (!groupSlug) throw new Error(UNSHARE_USAGE);

  await apiJson<ShareResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/share/${encodeURIComponent(groupSlug)}`,
    { method: "DELETE" },
  );
  console.log(`Unshared ${owner}/${skill} from ${groupSlug}.`);
}
