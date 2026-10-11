import { apiJson } from "../http.js";
import { KINDS, strictKind, type KindScope } from "../kinds.js";

// Same underlying endpoint as search.ts (GET /api/v1/skills, here with
// ?mine=true instead of ?q=), so it carries the same `profiles.username`
// join -- printing owner/slug (not just the bare slug) is what makes this
// output directly reusable by add/edit/star/remove/unpublish, which all
// require the full "<owner>/<skill>" form.
//
// Always lists the caller's own skills (public and private) -- this is
// "ahood skill list", the entity-scoped rename of the old flat "ahood
// list-mine". No owner argument or other filtering; that's out of scope
// for the rename.
type OwnSkill = {
  slug: string;
  name: string;
  tagline: string | null;
  visibility: string;
  kind?: string;
  downloads_count: number;
  stars_count: number;
  profiles: { username: string } | null;
};

// A strict kind is filtered by the registry: its `mine=true` branch honours
// ?kind= (ahood#657) and, with no page/per_page, still returns every owned
// row unpaginated -- the same shape as before.
export async function listOwnSkills(kind?: string): Promise<OwnSkill[]> {
  const query = kind ? `mine=true&kind=${encodeURIComponent(kind)}` : "mine=true";
  const { skills } = await apiJson<{ skills: OwnSkill[] }>(`/api/v1/skills?${query}`);
  return skills ?? [];
}

export async function listSkills(args: string[] = [], scope?: KindScope): Promise<void> {
  const jsonOutput = args.includes("--json");
  const kind = strictKind(scope);
  const skills = await listOwnSkills(kind);

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log(kind ? `You haven't published any ${KINDS[kind].plural} yet.` : "You haven't published any skills yet.");
    return;
  }
  for (const skill of skills) {
    // profiles comes from a server-side join that can plausibly be null for
    // an individual row -- degrade that one row instead of crashing the
    // whole command (ahood-cli#106).
    const username = skill.profiles?.username ?? "(unknown)";
    console.log(`${username}/${skill.slug} (${skill.visibility}) - ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads, ${skill.stars_count} stars)`);
  }
}
