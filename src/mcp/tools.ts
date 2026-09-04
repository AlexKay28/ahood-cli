import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "./safe-tool.js";
import { searchSkills } from "../commands/search.js";
import { viewSkill } from "../commands/view.js";
import { readSkillMd } from "../commands/read.js";
import { listSkillVersions } from "../commands/versions.js";
import { listOwnSkills } from "../commands/list.js";
import { checkAuth } from "../commands/whoami.js";
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
    "whoami",
    {
      description: "Report whether the configured token (AHOOD_TOKEN or a stored login) still authenticates.",
      inputSchema: {},
    },
    safeTool(async () => checkAuth()),
  );
}
