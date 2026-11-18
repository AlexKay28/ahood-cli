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
// frontmatter block with no trailing newline). CRLF-tolerant. The body +
// its trailing newline is ONE optional group (not a bare `*?` star) so an
// EMPTY frontmatter block (`---\n---\n`, zero body lines) still matches --
// without the group, nothing before the closing fence ever supplies the
// newline the star would need to see before it, and the whole pattern
// fails to match at all, which previously meant an empty frontmatter block
// was never recognised and the header landed BEFORE it instead of after
// (hardening pass, issue #1553 follow-up: parity with web's own fix).
const FRONTMATTER_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;

// Hardening pass (issue #1553 follow-up): title/owner/slug/version are
// interpolated into a markdown blockquote and an HTML comment, and none of
// the four is server-validated free-text (title in particular is whatever
// the registry's `name` column holds). \r/\n become a space each -- a raw
// newline inside any of them would otherwise let crafted content split the
// single-line blockquote or marker into extra lines (or, in the marker,
// break the HTML comment early). The five markdown-special characters that
// could otherwise reopen emphasis/links inside the blockquote, or prematurely
// close the code span the CTA's own backticks open, are backslash-escaped.
function escapeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/[*[\]()`]/g, (c) => `\\${c}`);
}

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

function renderHeaderLines(meta: ProvenanceHeaderMeta): [blockquote: string, marker: string] {
  // `url` is deliberately NOT escaped here: it is always the service's own
  // canonical ahood.dev link (getURL()/AHOOD_SITE_URL), never free text a
  // publisher controls the way title/owner/slug/version are.
  const title = escapeHeaderValue(meta.title);
  const owner = escapeHeaderValue(meta.owner);
  const slug = escapeHeaderValue(meta.slug);
  const version = escapeHeaderValue(meta.version);
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
  let before = rest.slice(0, fmEnd);
  const after = rest.slice(fmEnd);
  const eol = detectEol(content);
  // Hardening pass (issue #1553 follow-up): a frontmatter block with no
  // trailing EOL (FRONTMATTER_RE's own `$` branch -- the closing fence sits
  // at the very end of the string) leaves `before` without the newline
  // every other case already has between the fence and whatever follows.
  // Without this, the header would be glued directly onto the closing
  // "---" with no line break at all.
  if (fmEnd > 0 && !/[\r\n]$/.test(before)) before += eol;
  const [blockquote, marker] = renderHeaderLines(meta);
  return `${bom}${before}${blockquote}${eol}${marker}${eol}${eol}${after}`;
}
