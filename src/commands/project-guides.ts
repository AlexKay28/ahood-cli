// Bare `ahood project` (ahood-cli#185): the project guides that name this
// repository's git remote, via the hosted get_project_guide tool. Read-only:
// nothing is installed or written. The remote is normalized before it is
// sent or printed, so a token in origin's URL never leaves this machine.
import { flagValue } from "../flags.js";
import { callHostedTool } from "../hosted-mcp.js";
import { detectProjectRemote, normalizeProjectRemote } from "../project-remote.js";
import { sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood project [--remote <git-remote>] [--json]";

// get_project_guide's response (ahood lib/projects/project-guides.ts).
type ProjectGuide = {
  owner: string;
  slug: string;
  name: string;
  tagline: string | null;
  project: string | null;
  visibility: string;
  version: string;
  content: string;
  mine: boolean;
};
type ProjectGuideResult = { project: string | null; guides: ProjectGuide[] };

function resolveRemote(args: string[]): string {
  const explicit = flagValue(args, "--remote");
  if (explicit !== undefined) {
    const normalized = normalizeProjectRemote(explicit);
    if (!normalized.ok) throw new UsageError(`--remote is ${normalized.reason}.\n${USAGE}`);
    return normalized.value;
  }
  const detected = detectProjectRemote();
  if (!detected) {
    throw new UsageError(
      `No git remote found: this is not a git repository with an "origin" remote ahood can read. Pass --remote <git-remote>.\n${USAGE}`,
    );
  }
  return detected;
}

export async function findProjectGuides(args: string[]): Promise<void> {
  const unknown = args.filter((a, i) => a.startsWith("-") && a !== "--json" && a !== "--remote" && !a.startsWith("--remote=") && args[i - 1] !== "--remote");
  if (unknown.length > 0) throw new UsageError(`Unknown flag ${unknown[0]}.\n${USAGE}`);
  const remote = resolveRemote(args);
  const result = await callHostedTool<ProjectGuideResult>("get_project_guide", { remote });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.guides.length === 0) {
    console.log(`No project guides found for ${remote}. Write one with \`ahood project init\`.`);
    return;
  }
  console.log(`Project guides for ${remote}:`);
  for (const g of result.guides) {
    const tagline = g.tagline ? ` -- ${sanitizeForTerminal(g.tagline)}` : "";
    const mine = g.mine ? " (yours)" : "";
    console.log(`  ${g.owner}/${g.slug}@${g.version}  ${sanitizeForTerminal(g.name)}${tagline} [${g.visibility}]${mine}`);
  }
  const first = result.guides[0];
  console.log(`Install one with \`ahood project add ${first.owner}/${first.slug}\` (saved to .claude/project.md).`);
}
