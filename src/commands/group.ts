import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";
import { confirm } from "../confirm.js";
import { getApiUrl } from "../config.js";
import { UsageError } from "../usage-error.js";

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

const CREATE_USAGE = "Usage: ahood group create <name> [--description <text>]";
const LIST_USAGE = "Usage: ahood group list [--json]";
const MEMBERS_USAGE = "Usage: ahood group members <group> [--json]";
const INVITE_LINK_USAGE = "Usage: ahood group invite-link <group> [--json]";
const JOIN_USAGE = "Usage: ahood group join <invite-url-or-token>";
const REMOVE_MEMBER_USAGE = "Usage: ahood group remove-member <group> <username>";
const LEAVE_USAGE = "Usage: ahood group leave <group>";
const DELETE_USAGE = "Usage: ahood group delete <group> [--yes]";

// Creates a group (caller becomes owner). Follows edit.ts's convention of
// requiring the positional argument first, since --description takes a
// value and a "find the first non---flag token" scan would misidentify a
// bare description value (one that doesn't start with "--") as the name if
// --description happened to come first.
export async function createGroup(args: string[]): Promise<void> {
  const name = args[0];
  if (!name || name.startsWith("--")) throw new UsageError(CREATE_USAGE);
  const description = flagValue(args, "--description");

  const body: Record<string, unknown> = { name };
  if (description !== undefined) body.description = description;

  const created = await apiJson<{ id: string; slug: string; name: string }>("/api/v1/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log(`Created group ${created.name} (${created.slug}).`);
}

// Lists the caller's own groups (owner or member).
export async function listGroups(args: string[] = []): Promise<void> {
  const jsonOutput = args.includes("--json");
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
  const jsonOutput = args.includes("--json");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) throw new UsageError(MEMBERS_USAGE);

  const { group, members } = await apiJson<{ group: GroupSummary; members: Member[] }>(
    `/api/v1/groups/${encodeURIComponent(slug)}`,
  );

  if (jsonOutput) {
    console.log(JSON.stringify({ group, members }));
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
  const jsonOutput = args.includes("--json");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) throw new UsageError(INVITE_LINK_USAGE);

  const { token, expiresAt } = await apiJson<{ token: string; expiresAt: string }>(
    `/api/v1/groups/${encodeURIComponent(slug)}/invites`,
    { method: "POST" },
  );
  const url = `${getApiUrl()}/groups/join?token=${encodeURIComponent(token)}`;

  if (jsonOutput) {
    console.log(JSON.stringify({ token, expiresAt, url }));
    return;
  }
  console.log(url);
  console.log(`Expires: ${expiresAt}`);
  console.log("This link (and its token) is shown only this once -- save it now, it cannot be retrieved again.");
}

// Accepts either a full join URL (https://ahood.vercel.app/groups/join?token=...)
// or a bare raw token, for convenience -- whatever a user pastes from
// `ahood group invite-link` or forwards from someone else. Anything that
// doesn't parse as a URL, or parses but has no `token` query param, is
// treated as a raw token verbatim.
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
  const input = args.find((a) => !a.startsWith("--"));
  if (!input) throw new UsageError(JOIN_USAGE);
  const token = extractToken(input);

  const { groupSlug, groupName } = await apiJson<{ groupSlug: string; groupName: string }>(
    `/api/v1/groups/invites/${encodeURIComponent(token)}/accept`,
    { method: "POST" },
  );
  console.log(`Joined ${groupName} (${groupSlug}).`);
}

// Removes a member (owner-only for someone else; see leaveGroup below for
// "remove yourself"). No flags today, so plain positional filtering is
// unambiguous.
export async function removeMember(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [slug, username] = positional;
  if (!slug || !username) throw new UsageError(REMOVE_MEMBER_USAGE);

  await apiJson<{ removed: boolean }>(
    `/api/v1/groups/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
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
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) throw new UsageError(LEAVE_USAGE);

  const username = await getOwnUsername();
  await apiJson<{ removed: boolean }>(
    `/api/v1/groups/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE" },
  );
  console.log(`Left ${slug}.`);
}

// Owner-only, deletes the group outright -- mirrors unpublish.ts's
// confirmation-prompt pattern exactly (--yes bypasses it for scripts/CI,
// otherwise a typed "yes" is required).
export async function deleteGroup(args: string[]): Promise<void> {
  const yes = args.includes("--yes");
  const slug = args.find((a) => !a.startsWith("--"));
  if (!slug) throw new UsageError(DELETE_USAGE);

  const confirmed = yes
    ? true
    : await confirm(`This will permanently delete the group "${slug}" for all members. Type "yes" to confirm: `);

  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson<{ deleted: boolean }>(`/api/v1/groups/${encodeURIComponent(slug)}`, { method: "DELETE" });
  console.log(`Deleted group ${slug}.`);
}
