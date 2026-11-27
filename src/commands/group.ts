import { apiJson } from "../http.js";
import { parseArgs, YES_FLAGS } from "../flags.js";
import { confirm } from "../confirm.js";
import { assertJsonHasConsent, printJson } from "../json-output.js";
import { getApiUrl } from "../config.js";

// Mirrors GET /api/v1/groups' and GET /api/v1/groups/{slug}'s response
// shapes (see the ahood repo's app/api/v1/groups routes) -- owner_user_id is
// a raw id, not a username, since the list/detail routes don't join
// against profiles for it; only the per-member `username` (from the
// members join) is human-readable.
type GroupSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  owner_user_id: string;
  created_at: string;
};

type Member = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  role: "owner" | "member";
  joinedAt: string;
};

// `group members --json` passes the API's rows through, and that one route
// answers in camelCase while every other key this CLI emits is snake_case
// (ahood-cli#251). Each row gains the snake_case names; the camelCase ones
// stay as deprecated aliases so a script reading `userId` doesn't break.
function withSnakeCaseKeys(m: Member): Record<string, unknown> {
  return { user_id: m.userId, avatar_url: m.avatarUrl, joined_at: m.joinedAt, ...m };
}

const CREATE_USAGE = "Usage: ahood group create <name> [--description <text>] [--json]";
const LIST_USAGE = "Usage: ahood group list [--json]";
const MEMBERS_USAGE = "Usage: ahood group members <group> [--json]";
const INVITE_LINK_USAGE = "Usage: ahood group invite-link <group> [--json]";
const JOIN_USAGE = "Usage: ahood group join <invite-url-or-token> [--json]";
const REMOVE_MEMBER_USAGE = "Usage: ahood group remove-member <group> <username> [--yes] [--json]";
const LEAVE_USAGE = "Usage: ahood group leave <group> [--yes] [--json]";
const DELETE_USAGE = "Usage: ahood group delete <group> [--yes] [--json]";

// Creates a group (caller becomes owner). Every verb here parses through
// parseArgs before its first request (ahood-cli#260): `group delete team
// --dry-run --yes` used to delete the group. Every write verb here answers
// --json with one document (ahood-cli#251): they used to accept the flag and
// print prose, and `create`'s slug -- needed by every later `group` call --
// could only be scraped out of "Created group Team (team).".
export async function createGroup(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { usage: CREATE_USAGE, booleans: ["--json"], values: ["--description"], min: 1, max: 1 });
  const name = parsed.positionals[0];
  const description = parsed.value("--description");

  const body: Record<string, unknown> = { name };
  if (description !== undefined) body.description = description;

  const created = await apiJson<{ id: string; slug: string; name: string }>("/api/v1/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (parsed.has("--json")) {
    // The route's own row, passed through like `group list --json`'s.
    printJson(created);
    return;
  }
  console.log(`Created group ${created.name} (${created.slug}).`);
}

// Lists the caller's own groups (owner or member).
export async function listGroups(args: string[] = []): Promise<void> {
  const jsonOutput = parseArgs(args, { usage: LIST_USAGE, booleans: ["--json"], max: 0 }).has("--json");
  const { groups } = await apiJson<{ groups: GroupSummary[] }>("/api/v1/groups");

  if (jsonOutput) {
    console.log(JSON.stringify(groups));
    return;
  }
  if (groups.length === 0) {
    console.log("You don't belong to any groups yet. Run `ahood group create <name>` to make one.");
    return;
  }
  for (const g of groups) {
    console.log(`${g.slug} - ${g.name}${g.description ? `: ${g.description}` : ""}`);
  }
}

// Group detail + members -- 404s (mapped to exit code 5) if the caller
// isn't a member, same as any other not-found.
export async function groupMembers(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { usage: MEMBERS_USAGE, booleans: ["--json"], min: 1, max: 1 });
  const jsonOutput = parsed.has("--json");
  const slug = parsed.positionals[0];

  const { group, members } = await apiJson<{ group: GroupSummary; members: Member[] }>(
    `/api/v1/groups/${encodeURIComponent(slug)}`,
  );

  if (jsonOutput) {
    console.log(JSON.stringify({ group, members: members.map(withSnakeCaseKeys) }));
    return;
  }
  console.log(`${group.slug} - ${group.name}${group.description ? `: ${group.description}` : ""}`);
  for (const m of members) {
    console.log(`  ${m.username} (${m.role})`);
  }
}

// Creates/regenerates an invite link (owner-only). The response's `token`
// is raw and shown only this once server-side -- only its hash is stored,
// so there is no way to retrieve it again later, hence the warning below.
// The shareable URL is built from getApiUrl() (not a hardcoded prod host)
// so it stays correct against a non-default AHOOD_API_URL, same reasoning
// as view.ts's --web URL.
export async function inviteLink(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { usage: INVITE_LINK_USAGE, booleans: ["--json"], min: 1, max: 1 });
  const jsonOutput = parsed.has("--json");
  const slug = parsed.positionals[0];

  const { token, expiresAt } = await apiJson<{ token: string; expiresAt: string }>(
    `/api/v1/groups/${encodeURIComponent(slug)}/invites`,
    { method: "POST" },
  );
  // ahood#1271: every workspace page (including /groups) moved under
  // /workspace/... -- the old bare /groups/join path still 308-redirects
  // (next.config.ts), but a freshly generated link should point straight at
  // the current one.
  const url = `${getApiUrl()}/workspace/groups/join?token=${encodeURIComponent(token)}`;

  if (jsonOutput) {
    // `expiresAt` is a deprecated alias of `expires_at`, kept so existing
    // scripts don't break (ahood-cli#251).
    console.log(JSON.stringify({ token, expires_at: expiresAt, expiresAt, url }));
    return;
  }
  console.log(url);
  console.log(`Expires: ${expiresAt}`);
  console.log("This link (and its token) is shown only this once -- save it now, it cannot be retrieved again.");
}

// Accepts either a full join URL (https://www.ahood.dev/workspace/groups/join?token=...,
// or the pre-#1271 bare https://www.ahood.dev/groups/join?token=... -- the
// old path still 308-redirects and this only ever reads the `token` query
// param, never the path, so both keep working) or a bare raw token, for
// convenience -- whatever a user pastes from `ahood group invite-link` or
// forwards from someone else. Anything that doesn't parse as a URL, or
// parses but has no `token` query param, is treated as a raw token
// verbatim.
function extractToken(input: string): string {
  try {
    const url = new URL(input);
    const token = url.searchParams.get("token");
    if (token) return token;
  } catch {
    // Not a URL at all -- fall through and treat the whole input as the
    // raw token.
  }
  return input;
}

export async function joinGroup(args: string[]): Promise<void> {
  // dashIsPositional: a raw invite token is base64url, so one in 64 starts
  // with "-" and must not be refused as an unknown flag.
  const parsed = parseArgs(args, { usage: JOIN_USAGE, booleans: ["--json"], min: 1, max: 1, dashIsPositional: true });
  const token = extractToken(parsed.positionals[0]);

  const { groupSlug, groupName } = await apiJson<{ groupSlug: string; groupName: string }>(
    `/api/v1/groups/invites/${encodeURIComponent(token)}/accept`,
    { method: "POST" },
  );
  if (parsed.has("--json")) {
    printJson({ joined: true, slug: groupSlug, name: groupName });
    return;
  }
  console.log(`Joined ${groupName} (${groupSlug}).`);
}

// Removes a member (owner-only for someone else; see leaveGroup below for
// "remove yourself").
export async function removeMember(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { usage: REMOVE_MEMBER_USAGE, booleans: [...YES_FLAGS, "--json"], min: 2, max: 2 });
  const yes = parsed.has(...YES_FLAGS);
  const jsonOutput = parsed.has("--json");
  assertJsonHasConsent(jsonOutput, yes, REMOVE_MEMBER_USAGE);
  const [slug, username] = parsed.positionals;

  // Mirrors deleteGroup's confirm-before-destroy pattern (CLAUDE.md:
  // "Destructive commands ... prompt for confirmation unless --yes is
  // passed") -- a typo'd username here instantly removes the wrong member
  // with no other command to undo it (ahood-cli#99).
  const confirmed = yes
    ? true
    : await confirm(`Remove ${username} from ${slug}? Type "yes" to confirm: `);

  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson<{ removed: boolean }>(
    `/api/v1/groups/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
  if (jsonOutput) {
    printJson({ removed: true, slug, username });
    return;
  }
  console.log(`Removed ${username} from ${slug}.`);
}

// There's no cached username anywhere in credentials.ts (only the bearer
// token itself is stored) and no endpoint that echoes an identity for a
// bearer caller directly, so the caller's own username is resolved the
// same way whoami.ts's profile enrichment does: GET /api/v1/profile.
async function getOwnUsername(): Promise<string> {
  const profile = await apiJson<{ username: string }>("/api/v1/profile");
  return profile.username;
}

// "Leave" is just "remove-member" targeting yourself -- the API route
// handles both cases identically (DELETE .../members/{username} with your
// own username removes you, same as an owner removing someone else).
export async function leaveGroup(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { usage: LEAVE_USAGE, booleans: [...YES_FLAGS, "--json"], min: 1, max: 1 });
  const yes = parsed.has(...YES_FLAGS);
  const jsonOutput = parsed.has("--json");
  assertJsonHasConsent(jsonOutput, yes, LEAVE_USAGE);
  const slug = parsed.positionals[0];

  // Same confirm-before-destroy gate as removeMember -- an accidentally
  // re-run `leave` drops you from a private group with no other command to
  // undo it (ahood-cli#99).
  const confirmed = yes ? true : await confirm(`Leave ${slug}? Type "yes" to confirm: `);
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  const username = await getOwnUsername();
  await apiJson<{ removed: boolean }>(
    `/api/v1/groups/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
  if (jsonOutput) {
    printJson({ left: true, slug, username });
    return;
  }
  console.log(`Left ${slug}.`);
}

// Owner-only, deletes the group outright -- mirrors unpublish.ts's
// confirmation-prompt pattern exactly (--yes bypasses it for scripts/CI,
// otherwise a typed "yes" is required).
export async function deleteGroup(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { usage: DELETE_USAGE, booleans: [...YES_FLAGS, "--json"], min: 1, max: 1 });
  const yes = parsed.has(...YES_FLAGS);
  const jsonOutput = parsed.has("--json");
  assertJsonHasConsent(jsonOutput, yes, DELETE_USAGE);
  const slug = parsed.positionals[0];

  const confirmed = yes
    ? true
    : await confirm(`This will permanently delete the group "${slug}" for all members. Type "yes" to confirm: `);

  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson<{ deleted: boolean }>(`/api/v1/groups/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (jsonOutput) {
    printJson({ deleted: true, slug });
    return;
  }
  console.log(`Deleted group ${slug}.`);
}
