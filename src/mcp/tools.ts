import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "./safe-tool.js";
import { searchSkills } from "../commands/search.js";
import { viewSkill } from "../commands/view.js";
import { readSkillMd } from "../commands/read.js";
import { listSkillVersions } from "../commands/versions.js";
import { listOwnSkills } from "../commands/list.js";
import { checkAuth } from "../commands/whoami.js";
import { fetchVersionMeta } from "../commands/add.js";
import { validateSegment } from "../spec.js";

// MCP tool inputs arrive as separate owner/skill zod fields (not a single
// "<owner>/<skill>" spec string like the CLI's argv), so they bypass
// parseOwnerSkill entirely and go straight to the core function -- which
// URL-encodes them and hits the API. Running the same validateSegment checks
// the CLI gets via parseOwnerSkill here closes that gap: an invalid segment
// (e.g. "..") or an absurdly long one now fails locally as a UsageError
// (safeTool maps it to error_code "usage_error") instead of reaching the
// wire with the caller's bearer token.
function validateOwnerAndSkill(owner: string, skill: string): void {
  const spec = `${owner}/${skill}`;
  validateSegment(owner, "owner", spec);
  validateSegment(skill, "skill", spec);
}

// Registers every v1 MCP tool. Read-only by design (ahood-cli#83's spec) --
// each tool wraps the same core function the equivalent `ahood skill <verb>
// --json` CLI path already calls, so there is exactly one source of truth
// for what each of these returns.
export function registerTools(server: McpServer): void {
  server.registerTool(
    "skill_search",
    {
      description: "Search published skills in the ahood registry.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().optional() },
    },
    safeTool(async ({ query, limit }: { query: string; limit?: number }) => searchSkills(query, limit)),
  );

  server.registerTool(
    "skill_view",
    {
      description: "Show a skill's details (tags, license, homepage, repository, dates, etc.) without installing it.",
      inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    },
    safeTool(async ({ owner, skill }: { owner: string; skill: string }) => {
      validateOwnerAndSkill(owner, skill);
      return viewSkill(owner, skill);
    }),
  );

  server.registerTool(
    "skill_read",
    {
      description: "Read a skill's full SKILL.md content without installing it.",
      inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    },
    safeTool(async ({ owner, skill }: { owner: string; skill: string }) => {
      validateOwnerAndSkill(owner, skill);
      return readSkillMd(owner, skill);
    }),
  );

  server.registerTool(
    "skill_versions",
    {
      description: "List a skill's published-version history (version, changelog, size, publish date).",
      inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    },
    safeTool(async ({ owner, skill }: { owner: string; skill: string }) => {
      validateOwnerAndSkill(owner, skill);
      return listSkillVersions(owner, skill);
    }),
  );

  server.registerTool(
    "skill_list",
    {
      description: "List the authenticated caller's own skills, public and private.",
      inputSchema: {},
    },
    safeTool(async () => listOwnSkills()),
  );

  server.registerTool(
    "skill_outdated",
    {
      description:
        "Compare an explicit list of {owner, skill, version} pins (e.g. from an agent's own memory of what it " +
        "installed via MCP calls) against the registry's latest published version for each, returning " +
        "up-to-date status and changelog -- without reading or requiring any local lockfile. One entry " +
        "failing to resolve (e.g. a 404 for an unpublished skill) doesn't fail the whole batch; that entry's " +
        "result carries an `error` field instead.",
      inputSchema: {
        skills: z
          .array(
            z.object({
              owner: z.string().min(1),
              skill: z.string().min(1),
              version: z.string().min(1),
            }),
          )
          .min(1),
      },
    },
    safeTool(async ({ skills }: { skills: Array<{ owner: string; skill: string; version: string }> }) => {
      const results = [];
      for (const { owner, skill, version } of skills) {
        const label = `${owner}/${skill}`;
        try {
          validateOwnerAndSkill(owner, skill);
          const meta = await fetchVersionMeta(owner, skill, "latest");
          const upToDate = version === meta.version;
          results.push({
            skill: label,
            current_version: version,
            latest_version: meta.version,
            up_to_date: upToDate,
            changelog_md: upToDate ? null : meta.changelog_md ?? null,
          });
        } catch (error) {
          // One skill being removed/yanked/unreachable/invalid must not abort
          // resolution of the rest of the batch -- that's the whole point of
          // accepting an array instead of a single owner/skill pair. Mirrors
          // update.ts's own per-skill try/catch in its --dry-run loop.
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            skill: label,
            current_version: version,
            latest_version: null,
            up_to_date: false,
            changelog_md: null,
            error: message,
          });
        }
      }
      return results;
    }),
  );

  server.registerTool(
    "whoami",
    {
      description: "Report whether the configured token (AHOOD_TOKEN or a stored login) still authenticates.",
      inputSchema: {},
    },
    safeTool(async () => checkAuth()),
  );
}
