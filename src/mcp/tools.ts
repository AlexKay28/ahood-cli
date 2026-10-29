import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

// ahood#990 decision D: this local, stdio-only server predates the hosted
// registry MCP endpoint (https://www.ahood.dev/api/mcp, app/api/mcp/route.ts
// in the ahood repo) and named its tools before that one existed, so the two
// disagreed on names for the same operation (e.g. local `skill_view` vs.
// hosted `get_skill`). Every tool below is now registered under the hosted
// name it corresponds to; the original v1 name stays registered too, as a
// deprecated alias with the identical handler, so an existing host config
// (`claude mcp add ahood -- ahood mcp serve`) keeps working byte-for-byte.
// `skill_outdated` has no hosted twin with the same shape -- the hosted
// `ahood_status` tool is the closest equivalent (compares installed
// owner/skill/version pins against the registry), so that is the name it is
// aliased under, even though the hosted tool also reports evolution state
// this local one does not.
type ToolDef = {
  newName: string;
  oldName: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  // `any` rather than a generic bound to inputSchema: registerTool's own
  // overload already infers and checks the handler's parameter type from
  // inputSchema at each call site below (every handler is built by
  // safeTool() with its own concrete, schema-matching input type) -- this
  // wrapper only needs to carry that already-checked function through to
  // two registerTool calls (the new name and the deprecated old one)
  // without TypeScript trying (and failing) to unify two unrelated input
  // shapes behind one generic parameter.
  handler: (input: any) => Promise<CallToolResult>;
};

function registerWithDeprecatedAlias(server: McpServer, def: ToolDef): void {
  server.registerTool(def.newName, { description: def.description, inputSchema: def.inputSchema }, def.handler);
  server.registerTool(
    def.oldName,
    {
      description: `Deprecated alias for \`${def.newName}\`; use that instead. ${def.description}`,
      inputSchema: def.inputSchema,
    },
    def.handler,
  );
}

// Registers every v1 MCP tool (plus its ahood-cli#172/ahood#990 renamed
// twin). Read-only by design (ahood-cli#83's spec) -- each tool wraps the
// same core function the equivalent `ahood skill <verb> --json` CLI path
// already calls, so there is exactly one source of truth for what each of
// these returns.
export function registerTools(server: McpServer): void {
  registerWithDeprecatedAlias(server, {
    newName: "search_skills",
    oldName: "skill_search",
    description: "Search published skills in the ahood registry.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().positive().optional() },
    handler: safeTool(async ({ query, limit }: { query: string; limit?: number }) => searchSkills(query, limit)),
  });

  registerWithDeprecatedAlias(server, {
    newName: "get_skill",
    oldName: "skill_view",
    description: "Show a skill's details (tags, license, homepage, repository, dates, etc.) without installing it.",
    inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    handler: safeTool(async ({ owner, skill }: { owner: string; skill: string }) => {
      validateOwnerAndSkill(owner, skill);
      return viewSkill(owner, skill);
    }),
  });

  registerWithDeprecatedAlias(server, {
    newName: "read_skill",
    oldName: "skill_read",
    description: "Read a skill's full SKILL.md content without installing it.",
    inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    handler: safeTool(async ({ owner, skill }: { owner: string; skill: string }) => {
      validateOwnerAndSkill(owner, skill);
      return readSkillMd(owner, skill);
    }),
  });

  registerWithDeprecatedAlias(server, {
    newName: "list_skill_versions",
    oldName: "skill_versions",
    description: "List a skill's published-version history (version, changelog, size, publish date).",
    inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    handler: safeTool(async ({ owner, skill }: { owner: string; skill: string }) => {
      validateOwnerAndSkill(owner, skill);
      return listSkillVersions(owner, skill);
    }),
  });

  registerWithDeprecatedAlias(server, {
    newName: "list_my_skills",
    oldName: "skill_list",
    description: "List the authenticated caller's own skills, public and private.",
    inputSchema: {},
    handler: safeTool(async () => listOwnSkills()),
  });

  registerWithDeprecatedAlias(server, {
    newName: "ahood_status",
    oldName: "skill_outdated",
    description:
      "Compare an explicit list of {owner, skill, version} pins (e.g. from an agent's own memory of what it " +
      "installed via MCP calls) against the registry's latest published version for each, returning " +
      "up-to-date status and changelog -- without reading or requiring any local lockfile. One entry " +
      "failing to resolve (e.g. a 404 for an unpublished skill) doesn't fail the whole batch; that entry's " +
      "result carries an `error` field instead. Named to match the hosted registry MCP's `ahood_status` tool, " +
      "though this local version only reports version staleness, not evolution state.",
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
    handler: safeTool(async ({ skills }: { skills: Array<{ owner: string; skill: string; version: string }> }) => {
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
  });

  // No hosted twin shares this exact shape, so there is nothing to rename
  // or alias to -- registered once, under its original name.
  server.registerTool(
    "whoami",
    {
      description: "Report whether the configured token (AHOOD_TOKEN or a stored login) still authenticates.",
      inputSchema: {},
    },
    safeTool(async () => checkAuth()),
  );
}
