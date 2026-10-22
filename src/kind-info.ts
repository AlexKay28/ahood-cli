// Pure kind metadata (no imports, no I/O) so help.ts -- which
// scripts/sync-readme.mjs imports straight from dist/ -- can use it without
// pulling in the HTTP/filesystem layer. Behavior lives in kinds.ts.
//
// Kind-aware registry commands (ahood-cli#172).
//
// The registry stores six artifact kinds (the backend's
// lib/artifact-kinds.ts ALLOWED_KINDS: skill, agent, mcp, doc, project, loop), and a
// kind is fixed when an entry is created -- PATCH's allow-list has no `kind`
// -- so the kind an entry reports now is the kind it has always had. Each
// kind has a noun group (`ahood skill|agent|mcp|doc <verb>`), all run by one
// shared dispatcher. `doc` joined as the fourth in ahood-cli#182: it installs
// as one flat Markdown file, its DOC.md, the same shape an agent has.
// `project` joined as the fifth in ahood-cli#185: one PROJECT.md per
// repository, installed to the fixed path .claude/project.md. `loop` joined
// as the sixth (ahood-cli, ahood#858): a portable, reusable procedure for a
// recurring kind of agentic session, installed many-per-project like `doc`
// (.claude/loops/<owner>@<loop>.md), with DOC.md's exact frontmatter shape --
// no extra field, unlike `project`'s optional `project` remote, since a loop
// is explicitly not scoped to one repository.
//
// Per-kind facts live here, not in per-command branches: `placeholder` and
// `example` feed help and init, `about` the legacy `skill add` refusal.
export const KINDS = {
  skill: {
    label: "skill",
    article: "a",
    plural: "skills",
    rootDoc: "SKILL.md",
    installsTo: ".claude/skills/<owner>@<skill>/",
    placeholder: "<skill>",
    example: { slug: "alice/pdf-tools", name: "PDF Tools" },
  },
  agent: {
    label: "agent",
    article: "an",
    plural: "agents",
    rootDoc: "AGENT.md",
    installsTo: ".claude/agents/<owner>@<agent>.md",
    placeholder: "<agent>",
    example: { slug: "alice/code-reviewer", name: "Code Reviewer" },
  },
  mcp: {
    label: "MCP server manifest",
    article: "an",
    plural: "MCP server manifests",
    rootDoc: "server.json",
    installsTo: "an entry in .mcp.json",
    placeholder: "<server>",
    example: { slug: "alice/github-server", name: "GitHub Server" },
  },
  doc: {
    label: "doc",
    article: "a",
    plural: "docs",
    rootDoc: "DOC.md",
    installsTo: ".claude/docs/<owner>@<doc>.md",
    placeholder: "<doc>",
    example: { slug: "alice/setup-guide", name: "Setup Guide" },
    about: "a documentation page",
  },
  project: {
    label: "project guide",
    article: "a",
    plural: "project guides",
    rootDoc: "PROJECT.md",
    installsTo: ".claude/project.md",
    placeholder: "<slug>",
    example: { slug: "alice/acme-api", name: "Acme API" },
    about: "a guide to working in one repository",
  },
  loop: {
    label: "loop",
    article: "a",
    plural: "loops",
    rootDoc: "LOOP.md",
    installsTo: ".claude/loops/<owner>@<loop>.md",
    placeholder: "<loop>",
    example: { slug: "alice/code-review-pass", name: "Code Review Pass" },
    about: "a reusable procedure for a recurring kind of agentic session, portable across repositories",
  },
} as const satisfies Record<
  string,
  {
    label: string;
    article: "a" | "an";
    plural: string;
    rootDoc: string;
    installsTo: string;
    placeholder: string;
    example: { slug: string; name: string };
    about?: string;
  }
>;

export type CliKind = keyof typeof KINDS;
export const CLI_KINDS = Object.keys(KINDS) as CliKind[];

export function isCliKind(value: unknown): value is CliKind {
  return typeof value === "string" && (CLI_KINDS as string[]).includes(value);
}

// Kinds that install as one root-doc file pinned with its kind in the
// lockfile (doc: ahood-cli#182, project: #185, loop: ahood#858). The
// recorded kind is how remove/update recognise the pin offline, and how a
// project guide's shared path is claimed by exactly one pin. Legacy
// `skill add` refuses these.
export const PINNED_FILE_KINDS = ["doc", "project", "loop"] as const satisfies readonly CliKind[];
export type PinnedFileKind = (typeof PINNED_FILE_KINDS)[number];

export function isPinnedFileKind(value: unknown): value is PinnedFileKind {
  return typeof value === "string" && (PINNED_FILE_KINDS as readonly string[]).includes(value);
}
