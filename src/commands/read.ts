import { apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill read <owner>/<skill> [--json]";

// Matches GET /api/v1/skills/{owner}/{skill}'s actual response shape -- same
// endpoint view.ts calls (see view.ts's SkillDetail for the full field list
// and its provenance comment). Only the fields this command actually uses
// are declared here; skill_md_content is already selected server-side
// (app/api/v1/skills/[owner]/[skill]/route.ts's skill_versions join), it
// just wasn't typed/used by any command until now (ahood-cli#78).
type SkillReadDetail = {
  owner: string;
  slug: string;
  skill_versions: {
    version: string;
    skill_md_content: string | null;
    yanked_at?: string | null;
    yanked_reason?: string | null;
  } | null;
};

export async function readSkillMd(
  owner: string,
  skill: string,
): Promise<{ version: string; content: string; yanked_at: string | null; yanked_reason: string | null }> {
  const detail = await apiJson<SkillReadDetail>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
  );

  if (!detail.skill_versions) {
    throw new Error(`${owner}/${skill} has no published version.`);
  }

  // Mirrors view.ts's exact wording/tone for the same warning -- this
  // command reads straight from the same endpoint/version, so it must not
  // be silent about handing back a yanked version's content. Written to
  // stderr, not stdout -- safe for MCP callers too (only stdout is reserved
  // for the JSON-RPC stream).
  if (detail.skill_versions.yanked_at) {
    console.warn(
      `WARNING: ${detail.owner}/${detail.slug}@${detail.skill_versions.version} has been yanked${detail.skill_versions.yanked_reason ? `: ${detail.skill_versions.yanked_reason}` : "."}`,
    );
  }

  const content = detail.skill_versions.skill_md_content;
  if (!content) {
    throw new Error(`${owner}/${skill}@${detail.skill_versions.version} has no SKILL.md content available.`);
  }

  return {
    version: detail.skill_versions.version,
    content,
    // The CLI already warns about a yanked version on stderr above, but an
    // MCP caller has no visibility into stderr -- unlike skill_view, whose
    // returned object already surfaces yanked_at/yanked_reason, skill_read
    // was silently dropping this signal for MCP callers entirely. read()
    // below still destructures only {version, content} for the CLI's
    // --json output, so this addition doesn't change that shape.
    yanked_at: detail.skill_versions.yanked_at ?? null,
    yanked_reason: detail.skill_versions.yanked_reason ?? null,
  };
}

export async function read(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const { version, content } = await readSkillMd(owner, skill);

  if (jsonOutput) {
    console.log(JSON.stringify({ version, content }));
    return;
  }

  // Plain mode prints the raw content verbatim -- no formatting/labels/
  // trailing decoration -- since the whole point is fast/pipeable access to
  // the exact prompt text (e.g. piping into a file or another tool).
  console.log(content);
}
