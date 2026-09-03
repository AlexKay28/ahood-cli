import { join } from "node:path";

// Owner and skill segments become filesystem path components (.claude/skills/<owner>/<skill>)
// and URL path segments, so both are restricted to a safe charset that cannot contain "..",
// "/", "\", or a leading dot -- this is what closes the path-traversal hole in add/remove
// (a spec like "alice/.." previously resolved outside .claude/skills/ entirely).
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
export const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The backend enforces these same caps on write (app/api/v1/profile/route.ts's
// MAX_USERNAME_LENGTH for owner usernames; lib/skills/mutations.ts's
// createSkill 3-64 check for skill slugs), so a segment over these lengths
// can never match a real owner/skill anyway. Rejecting it here -- before any
// request is built -- turns a validly-charset-formatted but absurdly long
// segment into a clean local error instead of a network round trip that, at
// a truly pathological length (thousands of characters), hits a raw infra/
// CDN-layer URL-length limit and 502s before the backend's own routing ever
// runs (ahood-cli#38).
const MAX_SEGMENT_LENGTH: Record<"owner" | "skill", number> = { owner: 32, skill: 64 };

export function validateSegment(value: string, kind: "owner" | "skill", spec: string): void {
  if (!SEGMENT_RE.test(value) || value === "." || value === "..") {
    throw new Error(
      `Invalid ${kind} "${value}" in "${spec}" -- must start with a letter/digit and contain only letters, digits, ".", "_", or "-".`,
    );
  }
  const maxLength = MAX_SEGMENT_LENGTH[kind];
  if (value.length > maxLength) {
    throw new Error(
      `Invalid ${kind} in "${spec.slice(0, 60)}${spec.length > 60 ? "..." : ""}" -- ${kind} segment is too long (${value.length} characters; must be at most ${maxLength}).`,
    );
  }
}

export function parseOwnerSkill(spec: string, usage: string): { owner: string; skill: string } {
  if (!spec) throw new Error(usage);
  const parts = spec.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(usage);
  const [owner, skill] = parts;
  validateSegment(owner, "owner", spec);
  validateSegment(skill, "skill", spec);
  return { owner, skill };
}

export function parseOwnerSkillVersion(
  spec: string,
  usage: string,
): { owner: string; skill: string; version: string } {
  if (!spec) throw new Error(usage);
  const atIndex = spec.lastIndexOf("@");
  const ownerSkill = atIndex > 0 ? spec.slice(0, atIndex) : spec;
  const version = atIndex > 0 ? spec.slice(atIndex + 1) : "latest";
  if (atIndex > 0 && version === "") {
    throw new Error(`Missing version after "@" in "${spec}".\n${usage}`);
  }
  if (version !== "latest" && !SEMVER_RE.test(version)) {
    throw new Error(`Invalid version "${version}" in "${spec}" -- expected "latest" or a semver like 1.2.3.\n${usage}`);
  }
  const { owner, skill } = parseOwnerSkill(ownerSkill, usage);
  return { owner, skill, version };
}

// Applied to --homepage/--repository in edit and publish (ahood-cli#34):
// these are arbitrary user-supplied external links that the API stores
// verbatim and the web frontend renders as a raw <a href> -- a
// javascript:/data: value would be a stored-XSS vector the moment that
// page renders it. Rejecting anything but http(s) here, before any network
// call, mirrors config.ts's getApiUrl() validation pattern but with no
// localhost special-casing (there's no "trusted local dev" case for a
// public link). An empty string is allowed through un-validated so
// `edit --homepage ""` can still be used to clear a previously-set value.
export function validateExternalUrl(value: string, flag: string): void {
  if (value === "") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be a valid http:// or https:// URL (got "${value}").`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `${flag} must use http:// or https:// (got scheme "${url.protocol}" from "${value}").`,
    );
  }
}

export const SKILLS_ROOT = join(".claude", "skills");
export const LOCKFILE_PATH = join(".claude", "skills.lock.json");

export function skillDir(owner: string, skill: string): string {
  return join(SKILLS_ROOT, owner, skill);
}

// Claude Code's own subagent loader scans .claude/agents/*.md as flat files
// (non-recursive), unlike .claude/skills/<owner>/<skill>/ which nests by
// owner -- a bare .claude/agents/<skill>.md would let two different owners'
// same-named agent collide and silently overwrite each other. Joining the
// owner into the filename with a DOUBLE hyphen keeps the layout flat (so
// Claude Code still finds it) while staying collision-resistant: a single
// hyphen would be ambiguous, since SEGMENT_RE-valid slugs can themselves
// contain internal hyphens (owner="al-ice"/skill="bob" and
// owner="al"/skill="ice-bob" would both join to "al-ice-bob"). "--" can
// never appear inside a valid slug (an alphanumeric must follow every
// hyphen), so it's an unambiguous separator.
export const AGENTS_ROOT = join(".claude", "agents");

export function agentPath(owner: string, skill: string): string {
  return join(AGENTS_ROOT, `${owner}--${skill}.md`);
}
