import { apiJson } from "../http.js";

type OwnSkill = { slug: string; name: string; tagline: string | null; visibility: string; downloads_count: number; stars_count: number };

export async function listMine(): Promise<void> {
  const { skills } = await apiJson<{ skills: OwnSkill[] }>("/api/v1/skills?mine=true");
  if (skills.length === 0) {
    console.log("You haven't published any skills yet.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.slug} (${skill.visibility}) — ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads, ${skill.stars_count} stars)`);
  }
}
