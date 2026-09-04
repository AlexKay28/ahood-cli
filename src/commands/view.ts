import { spawn } from "node:child_process";
import { apiJson } from "../http.js";
import { getApiUrl } from "../config.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill view <owner>/<skill> [--json] [--web]";

// Matches GET /api/v1/skills/{owner}/{skill}'s actual response shape
// (app/api/v1/skills/[owner]/[skill]/route.ts): visibility is always
// present (resolveSkillByOwnerSlug's base column set), the rest is the
// route's explicit selectColumns list plus the owner/is_starred fields it
// adds after the query.
type SkillDetail = {
  slug: string;
  name: string;
  tagline: string | null;
  license: string | null;
  visibility: string;
  tags: string[];
  homepage: string | null;
  repository: string | null;
  downloads_count: number;
  stars_count: number;
  created_at: string;
  updated_at: string;
  owner: string;
  is_starred: boolean | null;
  skill_versions: {
    version: string;
    checksum_sha256: string;
    yanked_at?: string | null;
    yanked_reason?: string | null;
  } | null;
};

// Spawned with argv as an array (not a shell string), so a crafted owner/skill
// can never inject shell syntax -- and both segments are already restricted
// to a safe charset by parseOwnerSkill before this ever runs.
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    console.log(`Open this URL in your browser: ${url}`);
  }
}

export async function viewSkill(owner: string, skill: string): Promise<SkillDetail> {
  return apiJson<SkillDetail>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`);
}

export async function view(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const web = args.includes("--web");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const url = `${getApiUrl()}/${owner}/${skill}`;
  if (web) {
    openBrowser(url);
    return;
  }

  const detail = await viewSkill(owner, skill);

  if (jsonOutput) {
    console.log(JSON.stringify(detail));
    return;
  }

  const field = (label: string, value: string) => console.log(`  ${label.padEnd(13)}${value}`);
  console.log(`${detail.owner}/${detail.slug}`);
  // Mirrors the wording/tone of `ahood skill add`'s yanked warning (src/commands/add.ts)
  // and the website's skill detail page banner -- this is the one CLI surface
  // whose entire job is "let me check this out before deciding to install it",
  // so it must not be the one place that stays silent about a yanked version.
  if (detail.skill_versions?.yanked_at) {
    console.warn(
      `WARNING: ${detail.owner}/${detail.slug}@${detail.skill_versions.version} has been yanked${detail.skill_versions.yanked_reason ? `: ${detail.skill_versions.yanked_reason}` : "."}`,
    );
  }
  field("name:", detail.name);
  if (detail.tagline) field("tagline:", detail.tagline);
  field("tags:", detail.tags.length > 0 ? detail.tags.join(", ") : "-");
  field("license:", detail.license ?? "-");
  field("visibility:", detail.visibility);
  field("homepage:", detail.homepage ?? "-");
  field("repository:", detail.repository ?? "-");
  field("version:", detail.skill_versions ? detail.skill_versions.version : "no published version");
  field("downloads:", String(detail.downloads_count));
  field("stars:", String(detail.stars_count));
  field("created:", detail.created_at);
  field("updated:", detail.updated_at);
  if (detail.is_starred !== null) field("starred:", detail.is_starred ? "yes" : "no");
  console.log(url);
}
