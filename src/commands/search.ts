import { apiJson } from "../http.js";

type SearchResult = { skills: Array<{ slug: string; name: string; tagline: string | null; downloads_count: number; profiles: { username: string } }> };

export async function search(args: string[]): Promise<void> {
  const query = args.join(" ");
  if (!query) throw new Error("Usage: ahood search <query>");

  const { skills } = await apiJson<SearchResult>(`/api/v1/skills?q=${encodeURIComponent(query)}`);
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.profiles.username}/${skill.slug} — ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads)`);
  }
}
