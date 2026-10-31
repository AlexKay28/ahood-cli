import { apiJson } from "../http.js";
import { flagValue, parseSearchQuery } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { KINDS, strictKind, type CliKind, type KindScope } from "../kinds.js";

// GET /api/v1/skills's browse row (ahood app/api/v1/skills/route.ts select:
// id, slug, name, tagline, tags, kind, downloads_count, stars_count, user_id,
// profiles). kind and stars_count are additive (#657) and typed optional so an
// older server's row still parses; updated_at is not selected by that route.
export type SearchRow = {
  slug: string;
  name: string;
  tagline: string | null;
  kind?: string;
  downloads_count: number;
  stars_count?: number;
  updated_at?: string;
  profiles: { username: string } | null;
};
type SearchResult = { skills: SearchRow[] };

// The registry's browse sorts (ahood lib/skills/browse-sort.ts SORT_OPTIONS);
// an unknown value falls back to downloads server-side, so it is refused here
// instead of silently sorting by something the user did not ask for.
export const SEARCH_SORTS = ["rank", "downloads", "stars", "recent", "updated"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

const USAGE = "Usage: ahood skill search <query> [--json] [--limit <n>]";

// `kind` narrows the search server-side (GET /api/v1/skills?kind=, which the
// backend validates against its ALLOWED_KINDS). Omitted -- the legacy
// `ahood skill search` and the MCP skill_search tool -- the request is
// byte-for-byte what it always was: every kind. `ahood find` (ahood#1019) is
// the other caller: it may send no query at all (a plain browse, e.g. by
// downloads) and a `sort`; `q` is left out only when the query is empty,
// which `ahood skill search` never sends.
export async function searchSkills(query: string, limit?: number, kind?: CliKind, sort?: SearchSort): Promise<SearchRow[]> {
  const qs = new URLSearchParams(query === "" ? {} : { q: query });
  if (limit !== undefined) qs.set("per_page", String(limit));
  if (kind !== undefined) qs.set("kind", kind);
  if (sort !== undefined) qs.set("sort", sort);
  const { skills } = await apiJson<SearchResult>(`/api/v1/skills?${qs}`);
  return skills ?? [];
}

export async function search(args: string[], scope?: KindScope): Promise<void> {
  const kind = strictKind(scope);
  const jsonOutput = args.includes("--json");
  const limitStr = flagValue(args, "--limit");
  const query = parseSearchQuery(args, USAGE);
  if (limitStr !== undefined && (!/^\d+$/.test(limitStr) || Number(limitStr) < 1)) {
    throw new UsageError(`--limit must be a positive integer (got "${limitStr}").\n${USAGE}`);
  }
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;

  const skills = await searchSkills(query, limit, kind);

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log(kind ? `No ${KINDS[kind].plural} found.` : "No skills found.");
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
