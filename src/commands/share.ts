import { apiJson } from "../http.js";
import { parseArgs } from "../flags.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";
import { ensureRemoteKind, type KindScope } from "../kinds.js";

// These are skill-entity verbs (reached as `ahood skill share`/`ahood skill
// unshare`, registered in SKILL_COMMANDS in index.ts), not group verbs --
// they mutate a skill's sharing, not a group. Grouped together in one file
// the same way star.ts groups its own paired verbs (star/unstar).
const SHARE_USAGE = "Usage: ahood skill share <owner>/<skill> --group <group>";
const UNSHARE_USAGE = "Usage: ahood skill unshare <owner>/<skill> --group <group>";

type ShareResponse = { shared: boolean };

// Owner-of-the-skill-only server-side, and the caller must already be a
// member of the target group -- both enforced by the API, not re-checked
// here. The spec and --group may come in either order: parseArgs strips
// --group's value before looking for the positional (ahood-cli#260).
export async function share(args: string[], scope?: KindScope): Promise<void> {
  const parsed = parseArgs(args, { usage: SHARE_USAGE, booleans: ["--json"], values: ["--group"], min: 1, max: 1 });
  const { owner, skill } = parseOwnerSkill(parsed.positionals[0], SHARE_USAGE);
  const groupSlug = parsed.value("--group");
  if (!groupSlug) throw new UsageError(SHARE_USAGE);
  await ensureRemoteKind(scope, owner, skill, "share", "share");

  await apiJson<ShareResponse>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_slug: groupSlug }),
  });
  console.log(`Shared ${owner}/${skill} with ${groupSlug}.`);
}

export async function unshare(args: string[], scope?: KindScope): Promise<void> {
  const parsed = parseArgs(args, { usage: UNSHARE_USAGE, booleans: ["--json"], values: ["--group"], min: 1, max: 1 });
  const { owner, skill } = parseOwnerSkill(parsed.positionals[0], UNSHARE_USAGE);
  const groupSlug = parsed.value("--group");
  if (!groupSlug) throw new UsageError(UNSHARE_USAGE);
  await ensureRemoteKind(scope, owner, skill, "unshare", "unshare");

  await apiJson<ShareResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/share/${encodeURIComponent(groupSlug)}`,
    { method: "DELETE" },
  );
  console.log(`Unshared ${owner}/${skill} from ${groupSlug}.`);
}
