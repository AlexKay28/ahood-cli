import { apiJson } from "../http.js";

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
  downloads_count: number;
  stars_count: number;
  profiles: { username: string };
};

export async function listSkills(args: string[] = []): Promise<void> {
  const jsonOutput = args.includes("--json");
  const { skills } = await apiJson<{ skills: OwnSkill[] }>("/api/v1/skills?mine=true");

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log("You haven't published any skills yet.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.profiles.username}/${skill.slug} (${skill.visibility}) - ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads, ${skill.stars_count} stars)`);
  }
}
