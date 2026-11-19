// Issue #1553: the one place that knows what an ahood provenance header
// looks like, and the only code allowed to build or remove one. A copy of
// this module (byte-identical logic, parity-tested against
// tests/fixtures/provenance-header-vectors.json) lives in ahood-cli for the
// install/sync/read side of the same feature; this file is the web side's
// read half (MCP tool responses) and publish half (stripping a stale header
// out of a republished root doc before it ever reaches skill_md_content).
//
// Format (owner's spec, issue #1553):
//   > **Title** · [owner/slug](url) · vVERSION · from ahood.dev -- check for
//   updates: `ahood status` or /ahood
//   <!-- ahood:provenance v=1 ref=owner/slug@VERSION -->
//
// Placement: directly after the YAML frontmatter block when the content
// starts with one (`---\n...\n---\n`, so SKILL.md/AGENT.md keep frontmatter
// first for Claude Code and other hosts); otherwise at the very top.
//
// Idempotent: build(build(x)) === build(x). buildProvenanceHeader always
// strips any existing header at the canonical position first, so a
// re-install with a new version replaces the line instead of stacking a
// second one.
//
// stripProvenanceHeader is deliberately position-anchored, not a global
// find-and-delete: it only removes a header that sits exactly where build
// would have put it (right after frontmatter, or at the top), and only when
// the blockquote line immediately above the marker matches our exact
// template shape. A marker-shaped comment anywhere else in the document --
// including a line crafted by untrusted content to look like one -- is left
// untouched. That is what makes "strip" safe to run unconditionally on every
// publish.
//
// #1562 hardening (bug hunt on #1553, confirmed by executing this module):
// title/owner/slug/version are free text (skills.name especially -- a
// column with no markdown-safety constraint of its own) interpolated
// straight into a markdown blockquote and an HTML comment. Unescaped,
// `x** · [click](https://evil) · **y` as a title renders a forged owner
// link, and a raw \r/\n in any of the four splits the single-line
// blockquote/comment across lines -- which breaks stripProvenanceHeader's
// exact-position match (so build(build(x)) !== build(x): headers stack on
// every republish/read instead of replacing) as well as the surrounding
// document's own structure. escapeHeaderField below is applied to all four
// fields before they ever reach a template string.
//
// Also hardened here: a JSON root doc (mcp's server.json) must never be
// stamped at all -- a markdown blockquote would break JSON.parse for every
// reader. That decision lives with the one caller that knows the kind
// (lib/operations/catalog.ts's read_skill, gated on
// lib/artifact-kinds.ts's hasJsonRootDoc) -- this module has no notion of
// "kind" of its own to gate on.

export type ProvenanceHeaderMeta = {
  /** The artifact's display name/title. */
  title: string;
  owner: string;
  slug: string;
  /** Exact semver string. */
  version: string;
  /** Canonical ahood.dev URL for owner/slug (lib/get-url.ts's getURL). */
  url: string;
};

const MARKER_SCHEMA_VERSION = 1;
const CTA = "from ahood.dev — check for updates: `ahood status` or /ahood";

const BOM = "﻿";

// Non-greedy up to the first closing "---" line (or end of string, for a
// frontmatter block with no trailing newline). CRLF-tolerant. #1562: the
// body-plus-its-own-newline segment is wrapped as one optional group so
// EMPTY frontmatter ("---\n---") is recognized too -- without the `?`, the
// pattern demanded at least one body line (a newline strictly between the
// two fences), so "---\n---\nbody" fell through unmatched and the header
// landed before the frontmatter instead of after it.
const FRONTMATTER_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;

// Format-anchored, not value-anchored: the title/owner/slug/version/url can
// be anything, but the surrounding literal text (middle dots, "v", the CTA)
// must match exactly for a line to count as "ours".
const BLOCKQUOTE_RE = "> \\*\\*.+\\*\\* · \\[.+\\]\\(.+\\) · v\\S+ · from ahood\\.dev — check for updates: `ahood status` or /ahood";
const MARKER_RE = `<!-- ahood:provenance v=${MARKER_SCHEMA_VERSION} ref=\\S+ -->`;
// Anchored at the very start of the (post-frontmatter) text: blockquote,
// EOL, marker, then one or two EOLs -- whatever this module itself inserts
// between the marker and the rest of the content (see buildProvenanceHeader).
const HEADER_BLOCK_RE = new RegExp(`^(?:${BLOCKQUOTE_RE})(?:\\r?\\n)(?:${MARKER_RE})(?:\\r?\\n){1,2}`);

function splitBom(text: string): { bom: string; rest: string } {
  return text.startsWith(BOM) ? { bom: BOM, rest: text.slice(BOM.length) } : { bom: "", rest: text };
}

function detectEol(text: string): "\r\n" | "\n" {
  const index = text.indexOf("\n");
  return index > 0 && text[index - 1] === "\r" ? "\r\n" : "\n";
}

function frontmatterEnd(text: string): number {
  const match = text.match(FRONTMATTER_RE);
  return match ? match[0].length : 0;
}

/** #1562: collapses \r/\n to a space (a raw newline would split this
 *  template's single blockquote/comment line, breaking both the
 *  document's structure and stripProvenanceHeader's exact-position match),
 *  then backslash-escapes the five markdown metacharacters this template
 *  itself relies on (`* [ ] ( )` and the backtick in the CTA) so free text
 *  (skills.name especially) can never inject a fake `[label](url)` link or
 *  close the `**bold**` title early. */
function escapeHeaderField(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[*[\]()`]/g, "\\$&");
}

function renderHeaderLines(meta: ProvenanceHeaderMeta): [blockquote: string, marker: string] {
  const title = escapeHeaderField(meta.title);
  const owner = escapeHeaderField(meta.owner);
  const slug = escapeHeaderField(meta.slug);
  const version = escapeHeaderField(meta.version);
  const ref = `${owner}/${slug}@${version}`;
  const blockquote = `> **${title}** · [${owner}/${slug}](${meta.url}) · v${version} · ${CTA}`;
  const marker = `<!-- ahood:provenance v=${MARKER_SCHEMA_VERSION} ref=${ref} -->`;
  return [blockquote, marker];
}

/**
 * Removes exactly the header this module builds -- the blockquote line
 * directly above our marker comment, both at the canonical position (right
 * after frontmatter, or at the top) -- and nothing else. Returns the input
 * unchanged (same string, not just equal content) when there is nothing to
 * strip there.
 */
export function stripProvenanceHeader(content: string): string {
  const { bom, rest } = splitBom(content);
  const fmEnd = frontmatterEnd(rest);
  const before = rest.slice(0, fmEnd);
  const after = rest.slice(fmEnd);
  const match = after.match(HEADER_BLOCK_RE);
  if (!match) return content;
  return bom + before + after.slice(match[0].length);
}

/**
 * Inserts (or replaces) the provenance header at the canonical position.
 * Pure: no I/O, no network. Idempotent -- calling this twice with the same
 * meta reproduces the exact same string; calling it again with a new
 * version replaces the line rather than stacking a second one.
 */
export function buildProvenanceHeader(content: string, meta: ProvenanceHeaderMeta): string {
  const stripped = stripProvenanceHeader(content);
  const { bom, rest } = splitBom(stripped);
  const fmEnd = frontmatterEnd(rest);
  const before = rest.slice(0, fmEnd);
  const after = rest.slice(fmEnd);
  const eol = detectEol(content);
  const [blockquote, marker] = renderHeaderLines(meta);
  // #1562: a frontmatter block with no trailing EOL of its own (the whole
  // input was exactly "---\n...\n---", ending at FRONTMATTER_RE's `$`
  // alternative rather than a newline) needs one synthesized here --
  // without it, the fence's closing "---" and the header's opening "> **"
  // land on the same line, destroying the fence (e.g. "---> **Title**...").
  // Re-parsing the result afterwards (a later rebuild, or
  // stripProvenanceHeader) sees a real newline at this position either
  // way, so no special-casing is needed anywhere else.
  const needsFrontmatterEol = fmEnd > 0 && !/\r?\n$/.test(before);
  return `${bom}${before}${needsFrontmatterEol ? eol : ""}${blockquote}${eol}${marker}${eol}${eol}${after}`;
}
