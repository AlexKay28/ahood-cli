import { apiJson } from "../http.js";
import { provenanceMetaFor } from "./add.js";
import { buildProvenanceHeader, type ProvenanceHeaderMeta } from "../provenance-header.js";
import { parseOwnerSkill } from "../spec.js";
import { sanitizeDocumentForTerminal, sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";
import { ensureRemoteKind, strictKind, type KindScope } from "../kinds.js";
import { printRateHint } from "../rate-hint.js";

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
  // ahood#1553 step 4: this route already selects/spreads `name` (same
  // column add.ts's fetchVersionMeta reads for the same purpose) -- the
  // provenance header's title, falling back to the slug when absent.
  name?: string | null;
  skill_versions: {
    version: string;
    skill_md_content: string | null;
    yanked_at?: string | null;
    yanked_reason?: string | null;
    created_at?: string | null;
  } | null;
};

export type ReadSkillMdResult = {
  version: string;
  content: string;
  yanked_at: string | null;
  yanked_reason: string | null;
  // ahood#1553 step 4: this REST route's content is never stamped
  // server-side (only the MCP read_skill tool is), so the CLI builds the
  // header itself from this -- the same {title, owner, slug, version, url}
  // shape add.ts's install path stamps SKILL.md with.
  provenance: ProvenanceHeaderMeta;
  published_at: string | null;
};

export async function readSkillMd(owner: string, skill: string): Promise<ReadSkillMdResult> {
  const detail = await apiJson<SkillReadDetail>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
    // ahood#1640: this GET is consuming the content, so it counts as a read.
    { headers: { "X-Ahood-Usage": "read" } },
  );

  if (!detail.skill_versions) {
    throw new Error(`${owner}/${skill} has no published version.`);
  }

  // Mirrors view.ts's exact wording/tone for the same warning -- this
  // command reads straight from the same endpoint/version, so it must not
  // be silent about handing back a yanked version's content. Written to
  // stderr, not stdout -- safe for MCP callers too (only stdout is reserved
  // for the JSON-RPC stream).
  //
  // yanked_reason is publisher-controlled free text interpolated into a
  // CLI-authored line, which is exactly sanitizeForTerminal's case (and
  // exactly what add.ts does with manifest fields) -- not the document case
  // below, so it keeps the flatten-newlines/200-char defaults rather than
  // sanitizeDocumentForTerminal. Unconditional, not TTY-gated: nothing
  // round-trips a warning, so there is no byte-exactness to preserve here
  // (ahood-cli#133).
  if (detail.skill_versions.yanked_at) {
    console.warn(
      `WARNING: ${detail.owner}/${detail.slug}@${detail.skill_versions.version} has been yanked${detail.skill_versions.yanked_reason ? `: ${sanitizeForTerminal(detail.skill_versions.yanked_reason)}` : "."}`,
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
    provenance: provenanceMetaFor(detail.owner, detail.slug, { version: detail.skill_versions.version, name: detail.name }),
    published_at: detail.skill_versions.created_at ?? null,
  };
}

export async function read(args: string[], scope?: KindScope): Promise<void> {
  const jsonOutput = args.includes("--json");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  await ensureRemoteKind(scope, owner, skill, "read", "read");
  const { version, content, provenance } = await readSkillMd(owner, skill);

  // ahood#1553 step 4: --json keeps `content` exactly as the registry
  // served it (existing consumers, tests/read.test.ts, parse this already)
  // and adds the structured facts as their own field, additive.
  if (jsonOutput) {
    console.log(JSON.stringify({ version, content, provenance }));
    return;
  }

  // Plain mode prints the raw content verbatim -- no formatting/labels/
  // trailing decoration -- since the whole point is fast/pipeable access to
  // the exact prompt text (e.g. piping into a file or another tool).
  // process.stdout.write, not console.log: console.log unconditionally
  // appends its own "\n", so a well-formed SKILL.md that already ends in one
  // (the normal case) came out with a second, spurious trailing blank line --
  // a real, reported round-trip mismatch between "ahood skill read" and the
  // source file, even though the registry itself stores/serves the content
  // byte-exact (ahood-cli#90).
  //
  // That byte-exactness is a promise made to a *pipe*, though, and #90 is the
  // only reason the raw write exists. A human looking at a terminal gets no
  // value from it and pays for it with every control sequence the publisher
  // chose to embed, because skill_md_content is publisher-controlled free text
  // and `skill read` is the command the CLI advertises for inspecting a skill
  // *before* installing it -- the cautious path. An embedded OSC 52
  // ("\x1b]52;c;<base64>\x07") silently overwrites the reader's system
  // clipboard on xterm/kitty/wezterm/foot; cheaper variants retitle the window
  // (OSC 0), clear the screen and forge "verified safe" output (ESC[2J ESC[H),
  // or switch charsets (ESC(0) and corrupt every later line in the session. So
  // strip on the TTY path only, leaving the redirected path the exact bytes
  // #90 guaranteed (ahood-cli#133).
  //
  // ahood#1553 step 4: the provenance header is stamped on this same TTY
  // path, for the same reason -- a human reading `ahood read`'s output is
  // exactly who the header is for, and the piped path's byte-exactness
  // promise (#90 above) would otherwise be broken by injecting it there.
  // Built, not stripped, so run it through the sanitizer like the rest of
  // the document (its own field values are already escaped --
  // provenance-header.ts's escapeHeaderValue -- but this keeps it under
  // the same single safety net as everything else this command prints).
  if (process.stdout.isTTY) {
    process.stdout.write(sanitizeDocumentForTerminal(buildProvenanceHeader(content, provenance)));
    printRateHint(strictKind(scope) ?? "skill", owner, skill);
    return;
  }

  process.stdout.write(content);
}
