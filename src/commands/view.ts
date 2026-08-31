import { spawn } from "node:child_process";
import { apiJson } from "../http.js";
import { getApiUrl } from "../config.js";
import { parseOwnerSkill } from "../spec.js";

const USAGE = "Usage: ahood view <owner>/<skill> [--json] [--web]";

type SkillDetail = {
  slug: string;
  name: string;
  tagline: string | null;
  visibility: string;
  downloads_count: number;
  stars_count: number;
  skill_versions: { version: string; checksum_sha256: string } | null;
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

export async function view(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const web = args.includes("--web");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new Error(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const url = `${getApiUrl()}/${owner}/${skill}`;
  if (web) {
    openBrowser(url);
    return;
  }

  const detail = await apiJson<SkillDetail>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
  );

  if (jsonOutput) {
    console.log(JSON.stringify(detail));
    return;
  }
  console.log(`${owner}/${detail.slug} (${detail.visibility})`);
  console.log(detail.name);
  if (detail.tagline) console.log(detail.tagline);
  console.log(`${detail.downloads_count} downloads, ${detail.stars_count} stars`);
  console.log(detail.skill_versions ? `latest version: ${detail.skill_versions.version}` : "no published version");
  console.log(url);
}
