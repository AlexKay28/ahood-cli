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

export async function listOwnSkills(): Promise<OwnSkill[]> {
  const { skills } = await apiJson<{ skills: OwnSkill[] }>("/api/v1/skills?mine=true");
  return skills ?? [];
}

export async function listSkills(args: string[] = [], scope?: KindScope): Promise<void> {
  const jsonOutput = args.includes("--json");
  const kind = strictKind(scope);
  let skills = await listOwnSkills();

  // The backend's `mine=true` branch ignores ?kind= (it is a separate query
  // from the public search -- see app/api/v1/skills/route.ts), but it does
  // select each row's `kind` and returns every owned row unpaginated, so
  // filtering here is exact rather than a page-local approximation. A row with
  // no `kind` is left out of a strict listing rather than guessed into one,
  // and the omission is reported on stderr so --json stdout keeps its shape.
  if (kind) {
    const unknown = skills.filter((s) => typeof s.kind !== "string" || s.kind === "");
    skills = skills.filter((s) => s.kind === kind);
    if (unknown.length > 0) {
      console.warn(
        `WARNING: ${unknown.length} of your entries had no kind in the registry's response and were left out. ` +
          "Run `ahood skill list` (legacy, all kinds) to see them.",
      );
    }
  }

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
