// Canonical command list for terminal --help output. Kept in sync by hand
// with cli/README.md's table and app/docs/page.tsx's COMMANDS array (three
// copies of the same list, none of which can literally import from this
// file -- README.md is plain markdown and the docs page is a separate
// Next.js app) -- a comment in each of those two places points back here so
// a future command addition doesn't update only one.
//
// The command surface is split into two tiers, gh-style:
//   - TOP_LEVEL_COMMANDS_HELP: account/auth-scoped commands that stay flat
//     (login, logout, whoami, token, completion) -- same reasoning
//     `gh auth login` isn't `gh account login`.
//   - SKILL_COMMANDS_HELP: every registry verb, reached as `ahood skill
//     <verb>` -- legacy and cross-kind in this release (ahood-cli#172).
//   - AGENT_COMMANDS_HELP / MCP_COMMANDS_HELP: the same verbs, kind-scoped,
//     generated from one template (registryCommandsHelp); MCP's list also
//     carries `ahood mcp` / `ahood mcp serve`, the local stdio server.
//   - GROUP_COMMANDS_HELP / SNAP_COMMANDS_HELP: the other entity nouns.
//
// `summary` is a genuinely one-sentence blurb used only by the top-level
// `ahood --help` / `ahood skill --help` listings. `desc` is the full
// (possibly multi-sentence) description rendered in full by `ahood help
// <command>` / `ahood skill <verb> --help`. Keep `summary` self-contained --
// it must not depend on the reader having also seen `desc`.
import { KINDS, type CliKind } from "./kind-info.js";

export type CommandHelp = { usage: string; summary: string; desc: string; flags?: string[]; examples?: string[] };

export const TOP_LEVEL_COMMANDS_HELP: CommandHelp[] = [
  {
    usage: "ahood login",
    summary: "Device-code browser login, stores a token locally.",
    desc: "Device-code browser login, stores a token locally.",
  },
  { usage: "ahood logout", summary: "Removes the stored token.", desc: "Removes the stored token." },
  {
    usage: "ahood whoami [--json]",
    summary: "Reports whether your stored token still authenticates.",
    desc: "Reports whether your stored token still authenticates.",
    flags: ["--json    Emit a machine-readable result instead of prose."],
  },
  {
    usage: "ahood token create <name>|list [--json]|revoke <id> [--yes]",
    summary: "Manage personal API tokens.",
    desc:
      "Manage personal API tokens. All three subcommands require an existing browser-backed session -- a CLI " +
      "session authenticated with a bearer token can't manage tokens end-to-end; use /settings/tokens in the " +
      "browser instead.",
    flags: ["--yes    (revoke only) Skip the confirmation prompt and revoke immediately."],
    examples: ["ahood token create ci-runner", "ahood token list --json", "ahood token revoke <id>", "ahood token revoke <id> --yes"],
  },
  {
    usage: "ahood completion <bash|zsh|fish>",
    summary: "Print a shell completion script for the command names.",
    desc: "Print a shell completion script for the command names.",
    examples: ["ahood completion bash >> ~/.bashrc"],
  },
  {
    usage: "ahood help useme",
    summary: "Print the bundled ahood SKILL.md for an AI agent -- raw, offline, no login needed.",
    desc:
      "Print the ahood self-skill bundled with this exact CLI version: a complete SKILL.md teaching an AI agent " +
      "(or a human) when and how to use ahood. Stdout is the raw file and nothing else -- no banner, no colors -- " +
      "so it can be pasted into an agent's context, redirected into a file, or read directly by an agent with " +
      "shell access. Works offline and without credentials, and never writes to your project. It is not the " +
      "same as `ahood skill add alexkay/ahood`, which installs the registry-published copy as a separate, " +
      "pinned project skill.",
    examples: ["ahood help useme", "ahood help useme > ahood-SKILL.md"],
  },
];

export const SKILL_COMMANDS_HELP: CommandHelp[] = [
  {
    usage: "ahood skill search <query> [--json] [--limit <n>]",
    summary: "Search published skills.",
    desc: "Search published skills.",
    flags: [
      "--json        Emit the raw skill objects instead of formatted lines.",
      "--limit <n>   Cap the number of results.",
    ],
    examples: ["ahood skill search pdf-tools", "ahood skill search pdf-tools --json"],
  },
  {
    usage: "ahood skill view <owner>/<skill> [--json] [--web]",
    summary:
      "Show a single skill's details -- tags, license, homepage, repository, dates, and more -- without installing it (alias: ahood skill show).",
    desc: "Show a single skill's details (tags, license, homepage, repository, dates, etc.) without installing it. Alias: ahood skill show.",
    flags: [
      "--json   Emit the raw skill object instead of formatted lines.",
      "--web    Open the skill's page in your browser instead of printing.",
    ],
  },
  {
    usage: "ahood skill read <owner>/<skill> [--json]",
    summary: "Print a skill's full SKILL.md content, without installing it.",
    desc:
      "Print a skill's full SKILL.md content (the prompt itself) without installing it via `ahood skill add`. " +
      "Plain mode prints the raw content verbatim to stdout -- no formatting, no labels -- so it's safe to pipe " +
      "into a file or another tool.",
    flags: ["--json    Emit {version, content} as a single line instead of the raw content."],
    examples: ["ahood skill read alice/pdf-tools", "ahood skill read alice/pdf-tools --json"],
  },
  {
    usage: "ahood skill versions <owner>/<skill> [--json]",
    summary: "List a skill's published-version history -- version, changelog, size, and publish date.",
    desc: "List a skill's published-version history: version, changelog, size, and publish date. Most-recent first.",
    flags: ["--json    Emit the raw version objects instead of formatted text."],
  },
  {
    usage: "ahood skill diff <owner>/<skill> <versionA> <versionB> [--json]",
    summary: "Show what changed between two published versions -- a SKILL.md diff plus an added/removed/changed file summary.",
    desc:
      "Show what changed between two published versions of a skill: a unified diff of SKILL.md's content, plus a " +
      "summary of which files were added or removed based on the two versions' manifests (a common file's content " +
      "can only be confirmed changed for SKILL.md itself, since manifests don't carry per-file checksums). Both " +
      "versions must be explicit semver -- \"latest\" isn't accepted, since it could silently mean two different " +
      "things if a new version is published between resolving each side.",
    flags: ["--json    Emit {skillmd_diff, manifest: {added, removed, changed}} instead of formatted text."],
    examples: ["ahood skill diff alice/pdf-tools 1.0.0 1.1.0", "ahood skill diff alice/pdf-tools 1.0.0 1.1.0 --json"],
  },
  {
    usage: "ahood skill list [--json]",
    summary: "List your own skills, public and private.",
    desc: "List your own skills, public and private.",
    flags: ["--json    Emit the raw skill objects instead of formatted lines."],
  },
  {
    usage: "ahood skill add <owner>/<skill>[@version]",
    summary: "Install a skill into .claude/skills/, pinned in the lockfile.",
    desc:
      "Install a skill into .claude/skills/, pinned in the lockfile. An artifact published with --kind agent " +
      "installs instead as a single file at .claude/agents/<owner>@<skill>.md (Claude Code's own subagent " +
      "loader scans .claude/agents/*.md as flat files), not a .claude/skills/ directory. An artifact published " +
      "with --kind mcp installs by merging an entry into .mcp.json instead, prompting for any secret " +
      "environment variables its server.json declares that aren't already set in your shell.",
    examples: ["ahood skill add alice/pdf-tools", "ahood skill add alice/pdf-tools@1.2.0"],
  },
  {
    usage: "ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]",
    summary: "Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once.",
    desc:
      "Move the lockfile pin(s) forward to the latest version. With no argument, updates every installed skill; one failure doesn't stop the rest. " +
      "An mcp-kind entry is updated in place (re-resolving any secret environment variables) as long as its .mcp.json entry still matches what " +
      "ahood last installed there -- a hand-edited or unverifiable entry is refused rather than silently overwritten.",
    flags: [
      "--dry-run   Preview current vs. latest version (and the changelog for anything behind) without installing anything.",
      "--json      With --dry-run, emit structured preview objects instead of a formatted table.",
    ],
    examples: ["ahood skill update --dry-run", "ahood skill update alice/pdf-tools --dry-run --json"],
  },
  {
    usage: "ahood skill outdated [<owner>/<skill> ...] [--json]",
    summary: "Read-only staleness check comparing current and latest versions (with changelog) for installed skills.",
    desc:
      "Read-only staleness check across installed skills -- current vs. latest version, plus the changelog for " +
      "anything behind. With no argument, checks every installed skill; with one or more given, checks just " +
      "those. Never moves a lockfile pin or installs anything; equivalent to `ahood skill update --dry-run`.",
    flags: ["--json    Emit structured preview objects instead of a formatted table."],
    examples: ["ahood skill outdated", "ahood skill outdated alice/pdf-tools --json"],
  },
  {
    usage: "ahood skill remove <owner>/<skill> [--yes]",
    summary: "Uninstall and unpin a skill (local only, prompts for confirmation unless --yes is passed).",
    desc:
      "Uninstall and unpin (local only). Prompts for confirmation unless --yes is passed. For an mcp-kind install, " +
      "also deletes its .mcp.json entry as long as it still matches what ahood last installed there -- a hand-edited " +
      "or unverifiable entry is left in place and warned about instead of being silently touched.",
  },
  {
    usage: "ahood skill edit <owner>/<skill> [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]",
    summary: "Update a skill you own, changing only the flags you pass.",
    desc:
      "Update a skill you own. Only the flags you pass are changed. Every flag also accepts " +
      "the --flag=value form (e.g. --tagline=--fast and cheap), needed when a value itself starts with --.",
    flags: [
      "--tagline <text>              Short one-line description.",
      "--tags <comma,separated>      Replaces the skill's tag list.",
      "--license <id>                An SPDX license identifier, e.g. MIT.",
      "--visibility public|private   Who can see and install the skill.",
      "--homepage <url>              The skill's homepage URL.",
      "--repository <url>            The skill's source repository URL.",
    ],
    examples: ['ahood skill edit alice/pdf-tools --tagline "Merge and split PDFs"'],
  },
  {
    usage: "ahood skill unpublish <owner>/<skill>[@version] [--yes]",
    summary:
      "Delete a skill from the registry for every consumer, or yank a single version, not just your local install (prompts for confirmation unless --yes is passed).",
    desc:
      "Without @version: delete a skill from the registry for every consumer (not just your local install). " +
      "With @version (e.g. alice/foo@1.2.3): yank that single version instead of deleting the whole skill -- " +
      "it is marked yanked, not removed. Existing lockfile pins still resolve and verify against it, but new " +
      "installs are warned off it. Prompts for a typed \"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  { usage: "ahood skill star <owner>/<skill>", summary: "Star a skill.", desc: "Star a skill." },
  {
    usage: "ahood skill unstar <owner>/<skill>",
    summary: "Remove your star from a skill.",
    desc: "Remove your star from a skill.",
  },
  {
    usage: "ahood skill share <owner>/<skill> --group <group>",
    summary: "Share a skill you own with a group, without changing its public/private visibility.",
    desc:
      "Share a skill you own with a group. Sharing is additive -- it doesn't change the skill's own " +
      "public/private visibility, it just makes it visible to everyone in the group too. You must own the " +
      "skill and already be a member of the target group.",
    flags: ["--group <group>   The group's slug (from `ahood group list`)."],
    examples: ["ahood skill share alice/pdf-tools --group design-team"],
  },
  {
    usage: "ahood skill unshare <owner>/<skill> --group <group>",
    summary: "Stop sharing a skill you own with a group.",
    desc: "Stop sharing a skill you own with a group. Does not affect the skill's own visibility.",
    flags: ["--group <group>   The group's slug."],
    examples: ["ahood skill unshare alice/pdf-tools --group design-team"],
  },
  {
    usage: "ahood skill init [name]",
    summary: "Scaffold a new skill folder with a minimal, valid SKILL.md.",
    desc:
      "Scaffold a new skill folder with a minimal, valid SKILL.md. Creates ./<name>/SKILL.md if a name is given, " +
      "or ./SKILL.md in the current directory otherwise. Refuses to overwrite an existing SKILL.md at the target path.",
    examples: ["ahood skill init pdf-tools", "ahood skill init"],
  },
  {
    usage:
      "ahood skill publish <owner>/<skill>@<version> [--path <dir>] [--kind skill|agent|mcp] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--changelog <text>] [--json]",
    summary:
      "Publish a new version of a skill, agent, or mcp server manifest from a folder containing SKILL.md, AGENT.md, or server.json, creating the skill first if it doesn't already exist.",
    desc:
      "Publish a new version of a skill, agent, or mcp server manifest from a folder containing SKILL.md, AGENT.md, or server.json. If the artifact " +
      "doesn't exist yet, this creates it first -- pass --name to set its display name, and --kind agent or --kind mcp if " +
      "publishing an AGENT.md or server.json (auto-detected from the folder contents when only one of SKILL.md/AGENT.md/server.json is present). " +
      "--name is required when creating; optionally also pass --tagline/--tags/--license/--homepage/--repository. " +
      "Processing happens server-side after upload; this command polls and reports the final published/failed status. " +
      "The legacy form `ahood skill publish <path> --owner <owner> --slug <skill> --version <x.y.z>` is still accepted. " +
      "Every flag also accepts the --flag=value form, needed when a value itself starts with --.",
    flags: [
      "--kind skill|agent|mcp        What kind of artifact this is. Auto-detected from SKILL.md/AGENT.md/server.json when omitted.",
      "--name <text>                 Required only when creating the artifact on this publish.",
      "--tagline <text>              Short one-line description, used only when creating.",
      "--tags <comma,separated>      Initial tags, used only when creating.",
      "--license <id>                An SPDX license identifier, e.g. MIT, used only when creating.",
      "--homepage <url>              The artifact's homepage URL, used only when creating.",
      "--repository <url>            The artifact's source repository URL, used only when creating.",
      "--changelog <text>            What changed in this version, shown by `ahood skill versions`.",
      "--json                        Suppress human progress lines; print one {version,status,...} JSON object on completion (or {error} on failure).",
    ],
    examples: [
      "ahood skill publish alice/pdf-tools@1.1.0",
      'ahood skill publish alice/pdf-tools@1.0.0 --name "PDF Tools" --tagline "Merge and split PDFs"',
      "ahood skill publish alice/pdf-tools@1.1.0 --path ./pdf-tools",
    ],
  },
];

// Kind-scoped registry verbs (ahood-cli#172): `ahood agent <verb>` and
// `ahood mcp <verb>` take the same verbs as `ahood skill <verb>`, run by the
// same handlers, but strictly for their own kind -- a target of another kind
// is refused before any side effect. Generated from one template per verb
// rather than hand-copied twice, so the two lists can't drift from each other.
// SKILL_COMMANDS_HELP above stays hand-written: it documents the legacy,
// cross-kind behavior `ahood skill` keeps in this release.
function registryCommandsHelp(kind: Exclude<CliKind, "skill">): CommandHelp[] {
  const info = KINDS[kind];
  const n = kind === "agent" ? "<agent>" : "<server>";
  const p = `ahood ${kind}`;
  const label = info.label;
  const a = info.article;
  const plural = info.plural;
  const doc = info.rootDoc;
  const ex = kind === "agent" ? "alice/code-reviewer" : "alice/github-server";
  const kindRefusal = `Refused, before anything else happens, when the target is not ${a} ${label}.`;
  return [
    {
      usage: `${p} search <query> [--json] [--limit <n>]`,
      summary: `Search published ${plural}.`,
      desc: `Search published ${plural} only (the registry's ?kind=${kind} filter). Same output and --json shape as \`ahood skill search\`.`,
      flags: ["--json        Emit the raw result objects instead of formatted lines.", "--limit <n>   Cap the number of results."],
      examples: [`${p} search github`],
    },
    {
      usage: `${p} view <owner>/${n} [--json] [--web]`,
      summary: `Show a single ${label}'s details without installing it (alias: ${p} show).`,
      desc: `Show a single ${label}'s details without installing it. Alias: ${p} show. ${kindRefusal}`,
      flags: ["--json   Emit the raw object instead of formatted lines.", "--web    Open its page in your browser instead of printing."],
    },
    {
      usage: `${p} read <owner>/${n} [--json]`,
      summary: `Print a published ${label}'s ${doc}, without installing it.`,
      desc: `Print the ${doc} of a published ${label} verbatim, without installing it -- read it before you add it. ${kindRefusal}`,
      flags: ["--json    Emit {version, content} as a single line instead of the raw content."],
      examples: [`${p} read ${ex}`],
    },
    {
      usage: `${p} versions <owner>/${n} [--json]`,
      summary: `List a ${label}'s published-version history.`,
      desc: `List a ${label}'s published-version history: version, changelog, size, and publish date. ${kindRefusal}`,
      flags: ["--json    Emit the raw version objects instead of formatted text."],
    },
    {
      usage: `${p} diff <owner>/${n} <versionA> <versionB> [--json]`,
      summary: `Show what changed between two published versions of ${a} ${label}.`,
      desc: `Show what changed between two published versions, exactly like \`ahood skill diff\`. Both versions must be explicit semver. ${kindRefusal}`,
      flags: ["--json    Emit {skillmd_diff, manifest: {added, removed, changed}} instead of formatted text."],
    },
    {
      usage: `${p} list [--json]`,
      summary: `List your own ${plural}, public and private.`,
      desc:
        `List your own ${plural}, public and private. The registry returns every entry you own; this keeps only the ${kind} ones ` +
        "(an entry with no kind in the response is left out, with a warning on stderr). --json keeps `ahood skill list --json`'s shape.",
      flags: ["--json    Emit the raw objects instead of formatted lines."],
    },
    {
      usage: `${p} add <owner>/${n}[@version]`,
      summary: `Install ${a} ${label} into ${info.installsTo}, pinned in the lockfile.`,
      desc:
        `Install ${a} ${label} into ${info.installsTo}, pinned in .claude/skills.lock.json. ` +
        (kind === "mcp" ? "Prompts for any secret environment variables its server.json declares that aren't already set. " : "") +
        `Refused before anything is downloaded or written when the target is not ${a} ${label}.`,
      examples: [`${p} add ${ex}`, `${p} add ${ex}@1.2.0`],
    },
    {
      usage: `${p} update [<owner>/${n} ...] [--dry-run] [--json]`,
      summary: `Move ${label} pins forward to the latest version.`,
      desc:
        `Move lockfile pins forward to the latest version. With no argument, considers only the installed ${plural} ` +
        `in this project -- other kinds' pins are left alone. A named target that is not ${a} ${label} is refused and counted as a failure.`,
      flags: [
        "--dry-run   Preview current vs. latest version (and the changelog) without installing anything.",
        "--json      With --dry-run, emit structured preview objects instead of a formatted table.",
      ],
    },
    {
      usage: `${p} outdated [<owner>/${n} ...] [--json]`,
      summary: `Read-only staleness check for installed ${plural}.`,
      desc: `Read-only staleness check -- equivalent to \`${p} update --dry-run\`. With no argument, checks only the installed ${plural}.`,
      flags: ["--json    Emit structured preview objects instead of a formatted table."],
    },
    {
      usage: `${p} remove <owner>/${n} [--yes]`,
      summary: `Uninstall and unpin ${a} ${label} (local only, prompts unless --yes is passed).`,
      desc:
        `Uninstall and unpin ${a} ${label} from this project (local only). Refused, before the prompt and before anything is deleted, ` +
        `when the install is another kind; the kind is read from the project's own files, and from the registry only when they can't tell.`,
      flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
    },
    {
      usage: `${p} edit <owner>/${n} [--tagline] [--tags] [--license] [--visibility] [--homepage] [--repository]`,
      summary: `Update ${a} ${label} you own, changing only the flags you pass.`,
      desc: `Update ${a} ${label} you own; same flags as \`ahood skill edit\`. ${kindRefusal}`,
      flags: [
        "--tagline <text>              Short one-line description.",
        "--tags <comma,separated>      Replaces the tag list.",
        "--license <id>                An SPDX license identifier, e.g. MIT.",
        "--visibility public|private   Who can see and install it.",
        "--homepage <url>              Homepage URL.",
        "--repository <url>            Source repository URL.",
      ],
    },
    {
      usage: `${p} unpublish <owner>/${n}[@version] [--yes]`,
      summary: `Delete ${a} ${label} from the registry for every consumer, or yank one version (prompts unless --yes is passed).`,
      desc:
        `Without @version: delete ${a} ${label} from the registry for every consumer. With @version: yank that version. ` +
        `Refused before the prompt when the target is not ${a} ${label}.`,
      flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
    },
    { usage: `${p} star <owner>/${n}`, summary: `Star ${a} ${label}.`, desc: `Star ${a} ${label}. ${kindRefusal}` },
    { usage: `${p} unstar <owner>/${n}`, summary: `Remove your star from ${a} ${label}.`, desc: `Remove your star from ${a} ${label}. ${kindRefusal}` },
    {
      usage: `${p} share <owner>/${n} --group <group>`,
      summary: `Share ${a} ${label} you own with a group, without changing its visibility.`,
      desc: `Share ${a} ${label} you own with a group you belong to. ${kindRefusal}`,
      flags: ["--group <group>   The group's slug (from `ahood group list`)."],
    },
    {
      usage: `${p} unshare <owner>/${n} --group <group>`,
      summary: `Stop sharing ${a} ${label} you own with a group.`,
      desc: `Stop sharing ${a} ${label} you own with a group. ${kindRefusal}`,
      flags: ["--group <group>   The group's slug."],
    },
    {
      usage: `${p} init [name]`,
      summary: `Scaffold a new ${label} folder with a minimal, valid ${doc}.`,
      desc:
        `Scaffold a minimal ${doc} that passes the registry's publish validation: ./<name>/${doc} with a name, or ./${doc} without. ` +
        (kind === "mcp"
          ? "The starter points at a reserved example.com URL, so it can never install anyone's real server until you edit it. "
          : "") +
        `Refuses to overwrite an existing ${doc}, or to add one to a folder that already holds another kind's root document. ` +
        "Names are slug-normalized and must stay inside the current directory.",
      examples: [`${p} init ${ex.split("/")[1]}`, `${p} init`],
    },
    {
      usage: `${p} publish <owner>/${n}@<version> [--path <dir>] [--name <text>] [--tagline <text>] [--tags <comma,separated>] [--license <id>] [--homepage <url>] [--repository <url>] [--changelog <text>] [--json]`,
      summary: `Publish a new version of ${a} ${label} from a folder containing ${doc}, creating it first if it doesn't exist yet.`,
      desc:
        `Publish a new version from a folder containing ${doc}; the kind is implied, and a contradictory --kind is refused. ` +
        `If the entry already exists as another kind, this stops before anything is packed or uploaded. ` +
        "If it doesn't exist yet, it is created first -- pass --name for that. Otherwise the same flags and --json output as `ahood skill publish`.",
      flags: [
        "--path <dir>                  Folder to publish (default: the current directory).",
        "--name <text>                 Required only when creating the entry on this publish.",
        "--changelog <text>            What changed in this version.",
        "--json                        Print one {version,status,...} JSON object on completion (or {error} on failure).",
      ],
      examples: [`${p} publish ${ex}@1.0.0 --name "${kind === "agent" ? "Code Reviewer" : "GitHub Server"}"`],
    },
  ];
}

export const AGENT_COMMANDS_HELP: CommandHelp[] = registryCommandsHelp("agent");

// `ahood mcp` is two things (ADR 0007 in the ahood repo separates the hosted
// registry MCP endpoint from this CLI's local one): with no verb, or with
// `serve`, it is the local, read-only stdio MCP server that MCP hosts spawn;
// with a registry verb it manages mcp-kind registry entries (server.json
// manifests). Both are listed here so `ahood mcp --help` explains both.
export const MCP_SERVE_HELP: CommandHelp[] = [
  {
    usage: "ahood mcp serve",
    summary: "Start the local, read-only ahood MCP server over stdio (preferred spelling).",
    desc:
      "Start a Model Context Protocol server over stdio, exposing skill_search, skill_view, skill_read, " +
      "skill_versions, skill_list, skill_outdated, and whoami as MCP tools -- the same data ahood's --json " +
      "commands already return, reachable as typed tool calls instead of parsed CLI output. Meant to be " +
      "launched by an MCP-aware agent host (e.g. Claude Code's MCP server configuration), not run interactively. " +
      "Read-only by design. This is not the hosted registry MCP endpoint (https://ahood.vercel.app/api/mcp), which " +
      "is a separate server with write tools.",
    examples: ['claude mcp add ahood -- ahood mcp serve', "npx @ahood/cli@latest mcp serve"],
  },
  {
    usage: "ahood mcp",
    summary: "Same as `ahood mcp serve`, kept byte-for-byte so existing MCP host configs keep working.",
    desc:
      "With no arguments at all, `ahood mcp` starts the same stdio server as `ahood mcp serve` -- nothing is printed " +
      "to stdout before the protocol starts, and no login or network is needed to start it. Any other first word must " +
      "be `serve`, `--help`, or a registry verb below; anything unrecognized fails with usage instead of starting a server.",
  },
];

export const MCP_COMMANDS_HELP: CommandHelp[] = [...MCP_SERVE_HELP, ...registryCommandsHelp("mcp")];

// Every group-entity verb, all reached as `ahood group <verb>` -- mirrors
// SKILL_COMMANDS_HELP above, just for the "Groups" feature: private groups,
// shareable invite links, and sharing your own skills with a group without
// changing their public/private visibility.
export const GROUP_COMMANDS_HELP: CommandHelp[] = [
  {
    usage: "ahood group create <name> [--description <text>]",
    summary: "Create a private group, becoming its owner.",
    desc: "Create a private group. You become its owner.",
    flags: ["--description <text>   Optional short description."],
    examples: ['ahood group create "Design Team" --description "Shared skills for the design team"'],
  },
  {
    usage: "ahood group list [--json]",
    summary: "List groups you own or belong to.",
    desc: "List groups you own or belong to.",
    flags: ["--json    Emit the raw group objects instead of formatted lines."],
  },
  {
    usage: "ahood group members <group> [--json]",
    summary: "List a group's members and their role (owner-only visible to members).",
    desc:
      "List a group's details and members. Member-only -- you must belong to the group. Returns not found " +
      "(rather than a permission error) if you don't, so a group's existence isn't leaked to non-members.",
    flags: ["--json    Emit the raw group/members objects instead of formatted lines."],
  },
  {
    usage: "ahood group invite-link <group> [--json]",
    summary: "Create (or regenerate) a shareable invite link for a group you own.",
    desc:
      "Create or regenerate a shareable invite link for a group you own. Regenerating invalidates any " +
      "previously issued link. The raw token is shown only this once -- only its hash is stored server-side, " +
      "so it cannot be retrieved again later; save it (or the link) somewhere safe.",
    flags: ["--json    Emit {token, expiresAt, url} instead of formatted lines."],
  },
  {
    usage: "ahood group join <invite-url-or-token>",
    summary: "Join a group using an invite link or its raw token.",
    desc:
      "Join a group using an invite link (e.g. https://ahood.vercel.app/groups/join?token=...) or its bare " +
      "raw token -- either form works.",
    examples: [
      "ahood group join https://ahood.vercel.app/groups/join?token=abc123",
      "ahood group join abc123",
    ],
  },
  {
    usage: "ahood group remove-member <group> <username> [--yes]",
    summary: "Remove a member from a group you own (prompts for confirmation unless --yes is passed).",
    desc:
      "Remove a member from a group you own. The group's owner cannot be removed this way -- delete the " +
      "group instead. Only the group's owner can remove someone other than themselves. Prompts for a typed " +
      "\"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  {
    usage: "ahood group leave <group> [--yes]",
    summary: "Leave a group you belong to (prompts for confirmation unless --yes is passed).",
    desc:
      "Leave a group you belong to. The group's owner cannot leave -- delete the group instead. Prompts for " +
      "a typed \"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  {
    usage: "ahood group delete <group> [--yes]",
    summary: "Permanently delete a group you own (prompts for confirmation unless --yes is passed).",
    desc:
      "Permanently delete a group you own, removing it for every member. Prompts for a typed \"yes\" unless " +
      "--yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
];

// Every snap-entity verb, all reached as `ahood snap <verb>` -- mirrors
// GROUP_COMMANDS_HELP above, just for the "Snaps" feature (ahood-cli#107):
// a private, freeform text note capturing "what happened this session",
// searchable later by its owner, optionally shareable via a revocable link,
// never public otherwise.
export const SNAP_COMMANDS_HELP: CommandHelp[] = [
  {
    usage: "ahood snap create <content> [--tags tag1,tag2] [--json]",
    summary: "Capture a new private snap, from an argument or piped stdin.",
    desc:
      "Capture a new private snap. Pass the content as an argument, or omit it and pipe content on stdin " +
      "(e.g. `echo \"...\" | ahood snap create`, or a piped heredoc) -- useful for capturing a whole session's " +
      "worth of freeform text at once. Prints the new snap's id on success. An unrecognized flag is refused " +
      "rather than folded into the note; pass content that itself starts with `--` after a bare `--`.",
    flags: [
      "--tags <comma,separated>   Attach tags to the new snap.",
      "--json                     Emit {id, created_at} instead of just the bare id.",
      "--                         End of options: everything after it is content, verbatim.",
    ],
    examples: [
      'ahood snap create "Debugged the flaky CI step, root cause was a race in the cache key." --tags deploy,bugfix',
      'echo "..." | ahood snap create',
      'ahood snap create -- "--json broke the parser"',
    ],
  },
  {
    usage: "ahood snap list [--json] [--limit <n>] [--tags tag1,tag2]",
    summary: "List your own snaps, most recent first.",
    desc:
      "List your own snaps: id, a truncated content preview, created_at, a (shared) marker if shared, and " +
      "any tags in brackets. --tags narrows the list to snaps carrying every tag given (not any of them), " +
      "matched case-insensitively.",
    flags: [
      "--json               Emit the raw snap objects instead of formatted lines.",
      "--limit <n>          Cap the number of results.",
      "--tags tag1,tag2     Only snaps carrying ALL of these tags. Case-insensitive; at most 8.",
    ],
    examples: ["ahood snap list --tags deploy", "ahood snap list --tags deploy,bugfix --limit 5"],
  },
  {
    usage: "ahood snap search <query> [--json] [--limit <n>] [--tags tag1,tag2]",
    summary: "Search your own snaps by content.",
    desc:
      "Search your own snaps by content. Same output shape as `ahood snap list`. The query matches snap " +
      "CONTENT only and never a tag -- use --tags to filter by tag, which narrows the text results further.",
    flags: [
      "--json               Emit the raw snap objects instead of formatted lines.",
      "--limit <n>          Cap the number of results.",
      "--tags tag1,tag2     Only snaps carrying ALL of these tags. Case-insensitive; at most 8.",
    ],
    examples: ["ahood snap search flaky-ci", "ahood snap search deploy --tags ci"],
  },
  {
    usage: "ahood snap show <id> [--json]",
    summary: "Print a single snap's full content.",
    desc:
      "Print a single snap's full content. Plain mode prints the raw content verbatim to stdout -- no " +
      "formatting, no labels -- so it's safe to pipe into a file or another tool.",
    flags: ["--json    Emit the full snap object instead of the raw content."],
  },
  {
    usage: "ahood snap remove <id> [--yes]",
    summary: "Permanently delete a snap (prompts for confirmation unless --yes is passed).",
    desc: "Permanently delete a snap. Irreversible. Prompts for a typed \"yes\" unless --yes is passed.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  {
    usage: "ahood snap share <id> [--json]",
    summary: "Mint (or return the existing) shareable link for a snap.",
    desc: "Mint or return the existing shareable link for a snap. Idempotent -- safe to run more than once.",
    flags: ["--json    Emit {share_url} instead of just the bare URL."],
  },
  {
    usage: "ahood snap unshare <id> [--yes]",
    summary: "Revoke a snap's share link (the snap itself is untouched; prompts for confirmation unless --yes is passed).",
    desc:
      "Revoke a snap's share link -- the snap itself is untouched, and re-running `ahood snap share` mints a new " +
      "link. Prompts for a typed \"yes\" unless --yes is passed, since anyone using the old link loses access " +
      "immediately.",
    flags: ["--yes    Skip the interactive confirmation, for scripts/CI."],
  },
  {
    usage: "ahood snap tags <id> [tag ...] [--clear] [--json]",
    summary: "Print a snap's tags, or replace them with the tags given.",
    desc:
      "With no tag list, prints the snap's current tags and changes nothing. With a tag list, replaces the " +
      "full set -- this is not a merge, so any existing tags not listed are dropped. Tags may be given as " +
      "separate arguments, comma-separated, or both; quote a tag that contains a space. Clearing every tag " +
      "is explicit: pass --clear or an empty string. Each tag prints quoted, so one multi-word tag never " +
      "looks like two. No confirmation prompt: unlike remove/unshare this only touches metadata, never the " +
      "snap's content or shareability, and the tags it replaces can be read back first.",
    flags: [
      "--clear   Remove every tag from the snap.",
      "--json    Emit {id, tags} instead of a plain-text summary.",
    ],
    examples: [
      "ahood snap tags snap_123",
      "ahood snap tags snap_123 deploy bugfix",
      "ahood snap tags snap_123 deploy,bugfix",
      "ahood snap tags snap_123 --clear",
    ],
  },
];

// Exported so other consumers of the command list (e.g. shell completion) can
// surface aliases without needing their own copy of this map. Aliases apply
// at the skill-verb level today (e.g. "show" for "view"); nothing at the
// top level currently has one.
export const COMMAND_ALIASES: Record<string, string> = { show: "view" };

// Entity-scoped command lists, keyed by the entity name as it appears right
// after "ahood" in a usage string (e.g. "ahood skill <verb> ..."). Both
// findCommandHelp and usageWithAliases key off this map so a future entity
// only has to be added here once, not re-special-cased in both places.
const ENTITY_COMMANDS_HELP: Record<string, CommandHelp[]> = {
  skill: SKILL_COMMANDS_HELP,
  agent: AGENT_COMMANDS_HELP,
  mcp: MCP_COMMANDS_HELP,
  group: GROUP_COMMANDS_HELP,
  snap: SNAP_COMMANDS_HELP,
};

// Two-token lookup for an entity verb (findCommandHelp("skill", "search"),
// findCommandHelp("group", "create")) or a single-token lookup for a
// top-level command (findCommandHelp("whoami")).
export function findCommandHelp(command: string, subcommand?: string): CommandHelp | undefined {
  const entityList = ENTITY_COMMANDS_HELP[command];
  if (entityList && subcommand !== undefined) {
    // Try the literal verb first -- COMMAND_ALIASES is a single global map
    // ("show" -> "view", for skill's alias), but a different entity can
    // have its own real verb that happens to share the alias's name (e.g.
    // `ahood snap show`, a real verb, not an alias for anything). Resolving
    // through COMMAND_ALIASES unconditionally would send that lookup to a
    // nonexistent "ahood snap view" entry instead of the literal "ahood
    // snap show" one that's actually in this list.
    const literal = entityList.find(
      (c) => c.usage.startsWith(`ahood ${command} ${subcommand} `) || c.usage === `ahood ${command} ${subcommand}`,
    );
    if (literal) return literal;
    const resolved = COMMAND_ALIASES[subcommand] ?? subcommand;
    return entityList.find(
      (c) => c.usage.startsWith(`ahood ${command} ${resolved} `) || c.usage === `ahood ${command} ${resolved}`,
    );
  }
  const resolved = COMMAND_ALIASES[command] ?? command;
  return TOP_LEVEL_COMMANDS_HELP.find((c) => c.usage.startsWith(`ahood ${resolved} `) || c.usage === `ahood ${resolved}`);
}

// Renders a CommandHelp entry's usage line with any known aliases folded in
// after the primary command name, e.g. "ahood skill view <owner>/<skill> ..."
// -> "ahood skill view|show <owner>/<skill> ...". Used by the --help listings
// so aliases (like "show" for "view") aren't invisible to users who only
// skim `ahood --help` / `ahood skill --help`. The alias-carrying word is
// parts[2] for an entity usage string ("ahood skill <verb> ..." / "ahood
// group <verb> ...") and parts[1] for a top-level one ("ahood <command> ...").
export function usageWithAliases(entry: CommandHelp): string {
  const parts = entry.usage.split(" ");
  const idx = ENTITY_COMMANDS_HELP[parts[1]] ? 2 : 1;
  const name = parts[idx];
  const aliases = Object.keys(COMMAND_ALIASES).filter((alias) => COMMAND_ALIASES[alias] === name);
  if (aliases.length === 0) return entry.usage;
  parts[idx] = [name, ...aliases].join("|");
  return parts.join(" ");
}

export function formatCommandHelp(entry: CommandHelp): string {
  const lines = [entry.usage, "", entry.desc];
  if (entry.flags?.length) lines.push("", "Flags:", ...entry.flags.map((f) => `  ${f}`));
  if (entry.examples?.length) lines.push("", "Examples:", ...entry.examples.map((e) => `  ${e}`));
  return lines.join("\n");
}

const FALLBACK_TERMINAL_WIDTH = 80;

// Piped/redirected output (a script capturing `ahood skill --help`, a test)
// has no TTY and so no column count -- falls back to a fixed width rather
// than wrapping to whatever width happened to be inherited, so scripted use
// gets stable, repeatable output.
function terminalWidth(): number {
  const columns = process.stdout.columns;
  return columns && columns > 20 ? columns : FALLBACK_TERMINAL_WIDTH;
}

// Greedy word wrap -- doesn't split words, so a single word longer than
// `width` is left on its own overlength line rather than being cut mid-word.
function wrapText(text: string, width: number): string[] {
  if (width < 10) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Longest usage string an aligned label column will stretch to accommodate
// -- past this, one outlier (e.g. `skill publish`'s usage line, with every
// flag spelled out) would otherwise push every other row's description
// column out with it, which is what made `ahood skill --help` wrap to
// 300+ characters per line with no relation to the terminal's actual width
// (ahood-cli#81). A row whose usage is longer than this gets its summary on
// its own indented line instead of sharing the row.
const MAX_LABEL_COLUMN = 50;

// Renders a two-column command table (usage on the left, one-line summary on
// the right, aligned and wrapped to the terminal width) -- shared by
// formatSkillHelp/formatGroupHelp/formatHelp so all three `--help` listings
// wrap the same way.
function formatCommandTable(rows: Array<{ usage: string; summary: string }>): string[] {
  const longest = Math.max(...rows.map((r) => r.usage.length));
  const labelWidth = Math.min(longest, MAX_LABEL_COLUMN);
  const columnWidth = labelWidth + 4; // 2-space left margin + 2-space gutter after the label
  const summaryWidth = Math.max(20, terminalWidth() - columnWidth);
  const indent = " ".repeat(columnWidth);

  const lines: string[] = [];
  for (const row of rows) {
    const summaryLines = wrapText(row.summary, summaryWidth);
    if (row.usage.length <= labelWidth) {
      lines.push(`  ${row.usage.padEnd(labelWidth + 2)}${summaryLines[0]}`);
    } else {
      lines.push(`  ${row.usage}`);
      lines.push(`${indent}${summaryLines[0]}`);
    }
    for (const continuation of summaryLines.slice(1)) {
      lines.push(`${indent}${continuation}`);
    }
  }
  return lines;
}

// `ahood skill --help` -- the group-level listing for every skill verb.
export function formatSkillHelp(): string {
  const lines = formatCommandTable(SKILL_COMMANDS_HELP.map((c) => ({ usage: usageWithAliases(c), summary: c.summary })));
  return [
    "ahood skill -- manage skills in the ahood registry",
    "",
    "Legacy, cross-kind: in this release `ahood skill <verb>` still acts on any registry kind",
    "(skills, agents, MCP server manifests) -- `skill list`/`skill search` include every kind, and",
    "`skill add`/`skill update` install whatever kind they resolve. Scripts relying on that keep",
    "working. For one kind only, use `ahood agent <verb>` / `ahood mcp <verb>`, or add",
    "`--kind skill|agent|mcp` to any verb below (`--kind all` spells out the legacy behavior).",
    "A future major version will make `ahood skill` skills-only.",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood skill <command> --help` for a single command's flags and examples.",
  ].join("\n");
}

// `ahood agent --help` / `ahood mcp --help` -- kind-scoped registry verbs.
function formatRegistryKindHelp(header: string, intro: string[], entries: CommandHelp[], noun: string): string {
  const lines = formatCommandTable(entries.map((c) => ({ usage: usageWithAliases(c), summary: c.summary })));
  return [
    header,
    "",
    ...intro,
    "",
    "Commands:",
    ...lines,
    "",
    `Run \`ahood ${noun} <command> --help\` for a single command's flags and examples.`,
  ].join("\n");
}

export function formatAgentHelp(): string {
  return formatRegistryKindHelp(
    "ahood agent -- manage agent definitions (AGENT.md) in the ahood registry",
    [
      "Every verb here acts on agents only: a target of another kind is refused before anything",
      "is downloaded, prompted for, written, or sent. Installs land in .claude/agents/<owner>@<agent>.md.",
    ],
    AGENT_COMMANDS_HELP,
    "agent",
  );
}

export function formatMcpHelp(): string {
  return formatRegistryKindHelp(
    "ahood mcp -- the local MCP server, and MCP server manifests (server.json) in the ahood registry",
    [
      "Two meanings, told apart by the first word:",
      "  ahood mcp / ahood mcp serve   start this CLI's local, read-only MCP server over stdio",
      "                                (what MCP host configs launch; `serve` is the preferred spelling)",
      "  ahood mcp <verb>              manage mcp-kind registry entries (installs merge into .mcp.json)",
      "Neither is the hosted registry MCP endpoint, https://ahood.vercel.app/api/mcp.",
      "Registry verbs act on MCP server manifests only; another kind is refused before any side effect.",
    ],
    MCP_COMMANDS_HELP,
    "mcp",
  );
}

// One entry point for every registry noun's group help, so dispatch and
// `ahood help <noun>` can't disagree about which listing a noun gets.
export function formatKindHelp(noun: CliKind): string {
  if (noun === "agent") return formatAgentHelp();
  if (noun === "mcp") return formatMcpHelp();
  return formatSkillHelp();
}

// `ahood group --help` -- the group-level listing for every group verb.
export function formatGroupHelp(): string {
  const lines = formatCommandTable(GROUP_COMMANDS_HELP.map((c) => ({ usage: usageWithAliases(c), summary: c.summary })));
  return [
    "ahood group -- create private groups, invite members, and share skills with them",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood group <command> --help` for a single command's flags and examples.",
  ].join("\n");
}

// `ahood snap --help` -- the group-level listing for every snap verb.
export function formatSnapHelp(): string {
  const lines = formatCommandTable(SNAP_COMMANDS_HELP.map((c) => ({ usage: usageWithAliases(c), summary: c.summary })));
  return [
    "ahood snap -- capture and search private, session-scoped notes",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood snap <command> --help` for a single command's flags and examples.",
  ].join("\n");
}

// `ahood --help` -- the top-level listing: account commands rendered in
// full, plus a single summary line each pointing at `ahood skill --help`,
// `ahood group --help`, and `ahood snap --help` for their (much longer)
// entity command lists.
export function formatHelp(): string {
  const skillGroupUsage = "ahood skill <command>";
  const skillGroupSummary =
    "Search, install, and publish skills (legacy: also any other kind) -- run `ahood skill --help` for the full list.";
  const agentGroupUsage = "ahood agent <command>";
  const agentGroupSummary = "The same verbs, for agent definitions only -- run `ahood agent --help` for the full list.";
  const mcpGroupUsage = "ahood mcp <command>";
  const mcpGroupSummary =
    "The same verbs, for MCP server manifests only; bare `ahood mcp` or `ahood mcp serve` starts the local MCP server.";
  const groupGroupUsage = "ahood group <command>";
  const groupGroupSummary =
    "Create private groups and share skills with them -- run `ahood group --help` for the full list.";
  const snapGroupUsage = "ahood snap <command>";
  const snapGroupSummary =
    "Capture and search private, session-scoped notes -- run `ahood snap --help` for the full list.";
  const lines = formatCommandTable([
    ...TOP_LEVEL_COMMANDS_HELP.map((c) => ({ usage: usageWithAliases(c), summary: c.summary })),
    { usage: skillGroupUsage, summary: skillGroupSummary },
    { usage: agentGroupUsage, summary: agentGroupSummary },
    { usage: mcpGroupUsage, summary: mcpGroupSummary },
    { usage: groupGroupUsage, summary: groupGroupSummary },
    { usage: snapGroupUsage, summary: snapGroupSummary },
  ]);
  return [
    "ahood -- CLI for the ahood skills registry (https://ahood.vercel.app)",
    "",
    "Quick start:",
    "  ahood login",
    "  ahood skill search <something>",
    "  ahood skill add <owner>/<skill>",
    "",
    "Use ahood with an AI agent:",
    "  ahood help useme    Print a complete SKILL.md teaching an agent how to use ahood.",
    "                      Raw stdout, offline, no login -- paste it to an agent, or let an",
    "                      agent with a shell run it.",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ahood <command> --help` (or `ahood help <command>`) for a single command's flags and examples.",
    "Run `ahood skill --help` for the full list of skill commands.",
    "Run `ahood agent --help` / `ahood mcp --help` for the kind-scoped agent and MCP commands.",
    "Run `ahood group --help` for the full list of group commands.",
    "Run `ahood snap --help` for the full list of snap commands.",
    "Run `ahood --version` to print the installed CLI version.",
    "",
    "Exit codes: 0 success, 1 general error, 2 usage/validation error,",
    "            4 authentication required or rejected, 5 not found,",
    "            6 network/transport error or upstream server (5xx) error.",
    "",
    "Full reference: https://ahood.vercel.app/docs",
  ].join("\n");
}
