import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";

type SearchResult = { skills: Array<{ slug: string; name: string; tagline: string | null; downloads_count: number; profiles: { username: string } }> };

const USAGE = "Usage: ahood search <query> [--json] [--limit <n>]";

export async function search(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const limit = flagValue(args, "--limit");
  const queryParts = args.filter((a, i) => a !== "--json" && a !== "--limit" && args[i - 1] !== "--limit");
  const unknownFlag = queryParts.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new Error(`Unknown flag: ${unknownFlag}\n${USAGE}`);
  const query = queryParts.join(" ");
  if (!query) throw new Error(USAGE);
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1)) {
    throw new Error(`--limit must be a positive integer (got "${limit}").\n${USAGE}`);
  }

  const qs = new URLSearchParams({ q: query });
  if (limit !== undefined) qs.set("per_page", limit);
  const { skills } = await apiJson<SearchResult>(`/api/v1/skills?${qs}`);

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.profiles.username}/${skill.slug} - ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads)`);
  }
  if (limit !== undefined && skills.length >= Number(limit)) {
    console.log(`(showing up to ${limit} results -- pass a higher --limit for more)`);
  }
}
