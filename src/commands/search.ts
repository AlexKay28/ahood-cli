import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";
import { UsageError } from "../usage-error.js";

type SearchResult = {
  skills: Array<{
    slug: string;
    name: string;
    tagline: string | null;
    downloads_count: number;
    profiles: { username: string } | null;
  }>;
};

const USAGE = "Usage: ahood skill search <query> [--json] [--limit <n>]";

export async function searchSkills(query: string, limit?: number): Promise<SearchResult["skills"]> {
  const qs = new URLSearchParams({ q: query });
  if (limit !== undefined) qs.set("per_page", String(limit));
  const { skills } = await apiJson<SearchResult>(`/api/v1/skills?${qs}`);
  return skills ?? [];
}

export async function search(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const limitStr = flagValue(args, "--limit");
  // Strips both accepted forms flagValue itself supports -- "--limit 5" (this
  // token plus its following positional) and "--limit=5" (one combined
  // token) -- the latter previously survived into queryParts and tripped the
  // unknownFlag check below (ahood-cli#105).
  const queryParts = args.filter(
    (a, i) => a !== "--json" && a !== "--limit" && !a.startsWith("--limit=") && args[i - 1] !== "--limit",
  );
  const unknownFlag = queryParts.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${USAGE}`);
  const query = queryParts.join(" ");
  if (!query) throw new UsageError(USAGE);
  if (limitStr !== undefined && (!/^\d+$/.test(limitStr) || Number(limitStr) < 1)) {
    throw new UsageError(`--limit must be a positive integer (got "${limitStr}").\n${USAGE}`);
  }
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;

  const skills = await searchSkills(query, limit);

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  for (const skill of skills) {
    // profiles comes from a server-side join that can plausibly be null for
    // an individual row (orphaned skill, deleted owner account) -- degrade
    // that one row instead of crashing the whole command (ahood-cli#106).
    const username = skill.profiles?.username ?? "(unknown)";
    console.log(`${username}/${skill.slug} - ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads)`);
  }
  if (limit !== undefined && skills.length >= limit) {
    console.log(`(showing up to ${limit} results -- pass a higher --limit for more)`);
  }
}
