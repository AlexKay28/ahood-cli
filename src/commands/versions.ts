import { apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";

const USAGE = "Usage: ahood versions <owner>/<skill> [--json]";

// Matches GET /api/v1/skills/{owner}/{skill}/versions's response shape
// (app/api/v1/skills/[owner]/[skill]/versions/route.ts) -- the same
// select() list backing the MCP list_skill_versions tool. The route filters
// to status "published" and orders most-recent first server-side, so this
// command doesn't re-sort or re-filter.
//
// yanked_at/yanked_reason (ahood-cli#58) are optional/nullable: an older API
// response predating that select() addition simply omits them, which must
// degrade to "not yanked" rather than a runtime crash -- same convention as
// add.ts's VersionMeta.changelog_md.
type SkillVersion = {
  version: string;
  changelog_md: string | null;
  package_size_bytes: number;
  status: string;
  created_at: string;
  yanked_at?: string | null;
  yanked_reason?: string | null;
};

type VersionsResponse = { versions: SkillVersion[] };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export async function versions(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new Error(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const { versions: list } = await apiJson<VersionsResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions`,
  );

  if (jsonOutput) {
    console.log(JSON.stringify(list));
    return;
  }

  if (list.length === 0) {
    console.log(`${owner}/${skill} has no published versions.`);
    return;
  }

  console.log(`${owner}/${skill} -- ${list.length} published version${list.length === 1 ? "" : "s"}`);
  const field = (label: string, value: string) => console.log(`  ${label.padEnd(13)}${value}`);
  for (const v of list) {
    console.log("");
    console.log(v.version);
    field("published:", v.created_at);
    field("size:", formatSize(v.package_size_bytes));
    field("changelog:", v.changelog_md ? v.changelog_md : "-");
    // Marked right after the version's other details, only when the API
    // actually flags it (issue #58) -- non-yanked versions print exactly as
    // before, no "status:" line at all.
    if (v.yanked_at) {
      field("status:", v.yanked_reason ? `YANKED -- ${v.yanked_reason}` : "YANKED");
    }
  }
}
