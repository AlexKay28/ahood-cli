// Pure kind metadata (no imports, no I/O) so help.ts -- which
// scripts/sync-readme.mjs imports straight from dist/ -- can use it without
// pulling in the HTTP/filesystem layer. Behavior lives in kinds.ts.
//
// Kind-aware registry commands (ahood-cli#172).
//
// The registry stores four artifact kinds (the backend's
// lib/skills/validation.ts ALLOWED_KINDS: skill, agent, mcp, doc), and a
// kind is fixed when an entry is created -- PATCH's allow-list has no `kind`
// -- so the kind an entry reports now is the kind it has always had. This
// CLI has a noun group for three of them. `doc` is a real registry kind left
// out of this CLI's scope on purpose; adding it means one entry in KINDS
// below plus its help/init template, not a new dispatcher.
export const KINDS = {
  skill: {
    label: "skill",
    article: "a",
    plural: "skills",
    rootDoc: "SKILL.md",
    installsTo: ".claude/skills/<owner>@<skill>/",
  },
  agent: {
    label: "agent",
    article: "an",
    plural: "agents",
    rootDoc: "AGENT.md",
    installsTo: ".claude/agents/<owner>@<agent>.md",
  },
  mcp: {
    label: "MCP server manifest",
    article: "an",
    plural: "MCP server manifests",
    rootDoc: "server.json",
    installsTo: "an entry in .mcp.json",
  },
} as const satisfies Record<string, { label: string; article: "a" | "an"; plural: string; rootDoc: string; installsTo: string }>;

export type CliKind = keyof typeof KINDS;
export const CLI_KINDS = Object.keys(KINDS) as CliKind[];

export function isCliKind(value: unknown): value is CliKind {
  return typeof value === "string" && (CLI_KINDS as string[]).includes(value);
}

