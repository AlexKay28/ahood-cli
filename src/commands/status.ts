import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiJson } from "../http.js";
import { unrecognizedArgs } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { sanitizeForTerminal } from "../terminal-safe.js";
import { itemKey, migrateProjectLockfileOrWarn, readInstalled, type InstalledItem } from "../installed.js";
import { reconcileLockfileSkillId } from "../lockfile.js";
import { LOCKFILE_PATH } from "../spec.js";
import { highestSeverityNotice, maybeNotifyUpdate, noticeAnnouncementLine, type CliNotice } from "../update-notifier.js";

const USAGE = "Usage: ahood status [--json]";

// web #1552 step 4 / #1554 step 2 (ahood_status, now shipped on origin/dev
// e6601682 -- lib/status/installed.ts, lib/client-versions.ts's
// ClientStatusBlock): an additive `ahood` block plus a top-level
// `notices[]` on this same response. Every field here is still read
// defensively (optional chaining throughout): an OLDER server that hasn't
// deployed this yet simply omits both, and this CLI must keep working
// against it either way.
export type AhoodStatusBlock = {
  server?: { version?: string; sha?: string; built_at?: string };
  client?: {
    surface?: string;
    version?: string;
    latest?: string;
    update_available?: boolean;
    below_minimum?: boolean;
    upgrade_command?: string;
  } | null;
};

// POST /api/v1/me/status (ahood#978, lib/skills/installed-status.ts on the
// server). Mirrors InstalledStatusItem / InstalledStatus exactly.
export type ServerEvolution = {
  enabled: boolean;
  promotion_mode: "review" | "automatic";
  probe_mode: string;
  pending_proposals: number;
};
export type ServerStatusItem =
  | { owner: string; slug: string; installed_version: string | null; status: "not_found" }
  | {
      owner: string;
      slug: string;
      installed_version: string | null;
      status: "ok";
      kind: string;
      latest_version: string | null;
      update_available: boolean;
      is_owner: boolean;
      evolution?: ServerEvolution;
      // ahood-cli#1320 contract §5 (ahood#1395): the server's stable
      // identity for this artifact, and the canonical (possibly renamed)
      // owner -- both optional so an older server response still parses.
      // See reconcileSkillIds below for what this CLI does with them.
      skill_id?: string;
      canonical_owner?: string;
    };
export type ServerStatus = {
  items: ServerStatusItem[];
  plan: { evolution_available: boolean; consented: boolean };
  /** Optional (web #1552 step 4); see AhoodStatusBlock above. */
  ahood?: AhoodStatusBlock;
  /** Optional (web #1554 step 2); already de-duplicated and audience-filtered server-side. */
  notices?: CliNotice[];
};

/** The server's documented per-request cap (MAX_STATUS_ITEMS). */
export const STATUS_BATCH = 500;

/** One request per 500 distinct artifacts. The server answers per
 *  owner/slug; the installed version sent is the first install's, and
 *  update_available is recomputed per install by the caller (toRow). */
export async function fetchStatus(
  items: InstalledItem[],
): Promise<{
  byKey: Map<string, ServerStatusItem>;
  plan: ServerStatus["plan"] | null;
  ahood: AhoodStatusBlock | null;
  notices: CliNotice[];
}> {
  const distinct = new Map<string, InstalledItem>();
  for (const item of items) {
    const key = itemKey(item).toLowerCase();
    if (!distinct.has(key)) distinct.set(key, item);
  }
  const unique = [...distinct.values()];
  const byKey = new Map<string, ServerStatusItem>();
  let plan: ServerStatus["plan"] | null = null;
  let ahood: AhoodStatusBlock | null = null;
  // Notices are per-caller, not per-batch (the server computes them once,
  // independent of `installed`), so the last batch's answer (if any) wins --
  // in practice there's exactly one batch for the overwhelming majority of
  // callers (<=500 distinct installs).
  let notices: CliNotice[] = [];
  for (let i = 0; i < unique.length; i += STATUS_BATCH) {
    const batch = unique.slice(i, i + STATUS_BATCH);
    const res = await apiJson<ServerStatus>("/api/v1/me/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installed: batch.map((b) => ({ owner: b.owner, slug: b.slug, version: b.version })) }),
    });
    plan = res.plan;
    if (res.ahood) ahood = res.ahood;
    if (Array.isArray(res.notices)) notices = res.notices;
    // The server lowercases owner/slug; match on that.
    for (const s of res.items) byKey.set(`${s.owner}/${s.slug}`.toLowerCase(), s);
  }
  return { byKey, plan, ahood, notices };
}

export type StatusRow = {
  owner: string;
  slug: string;
  kind: string | null;
  installed_version: string;
  latest_version: string | null;
  /** The registry's latest differs from this install's version. */
  update_available: boolean;
  pinned: string | null;
  /** The version `ahood sync` would move this install to; null = nothing to do. */
  sync_target: string | null;
  status: "ok" | "not_found";
  installed_path: string;
  project_dir: string;
  /** The installed files are gone from disk (removed by hand). */
  missing: boolean;
  is_owner: boolean;
  evolution: ServerEvolution | null;
  /** ahood-cli#1320 contract §5: this entry's recorded skillId disagrees
   *  with the server's for this owner/slug -- the name now points at a
   *  different skill, and sync_target is forced to null so nothing (this
   *  command, `ahood sync`) moves it forward. */
  skill_id_mismatch: boolean;
};

/** What sync would move an install to: a pin holds it at the pinned version
 *  (moving there if it isn't on it yet), otherwise the latest. */
export function syncTarget(item: InstalledItem, latest: string | null): string | null {
  const target = item.pinned ?? latest;
  return target !== null && target !== item.version ? target : null;
}

export function toRow(item: InstalledItem, server: ServerStatusItem | undefined, skillIdMismatch = false): StatusRow {
  const ok = server?.status === "ok" ? server : undefined;
  const latest = ok?.latest_version ?? null;
  return {
    owner: item.owner,
    slug: item.slug,
    kind: item.kind ?? ok?.kind ?? null,
    installed_version: item.version,
    latest_version: latest,
    update_available: latest !== null && latest !== item.version,
    pinned: item.pinned ?? null,
    sync_target: ok && !skillIdMismatch ? syncTarget(item, latest) : null,
    status: ok ? "ok" : "not_found",
    installed_path: item.installedPath,
    project_dir: item.projectDir,
    missing: !existsSync(item.installedPath),
    is_owner: ok?.is_owner ?? false,
    evolution: ok?.evolution ?? null,
    skill_id_mismatch: skillIdMismatch,
  };
}

/** ahood-cli#1320 contract §5: reconcile every found item's project
 *  lockfile entry against the server's skill_id/canonical_owner --
 *  recording a missing skillId, moving a renamed account's entry to its
 *  canonical owner, or refusing (and reporting) a skillId mismatch. Returns
 *  the keys (`<projectDir>::<owner>/<slug>`, lowercased) that were refused,
 *  for toRow to block sync_target on. Best-effort per item: one project's
 *  broken lockfile must not stop every other item's status/sync. */
function reconcileSkillIds(items: InstalledItem[], byKey: Map<string, ServerStatusItem>): Set<string> {
  const mismatched = new Set<string>();
  for (const item of items) {
    const server = byKey.get(itemKey(item).toLowerCase());
    if (!server || server.status !== "ok" || !server.skill_id) continue;
    const lockPath = join(item.projectDir, LOCKFILE_PATH);
    try {
      const outcome = reconcileLockfileSkillId(lockPath, itemKey(item), {
        skillId: server.skill_id,
        canonicalOwner: server.canonical_owner,
      });
      if (outcome.action === "refused") {
        console.warn(`WARNING: ${sanitizeForTerminal(outcome.message)}`);
        mismatched.add(`${item.projectDir}::${itemKey(item).toLowerCase()}`);
      } else if (outcome.action === "renamed") {
        console.log(`${sanitizeForTerminal(outcome.from)} is now ${sanitizeForTerminal(outcome.to)} -- its account was renamed, and the pin in ${lockPath} was updated to match.`);
      }
    } catch (error) {
      console.warn(
        `WARNING: could not reconcile ${itemKey(item)}'s entry in ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return mismatched;
}

export async function loadStatusRows(): Promise<{
  items: InstalledItem[];
  rows: StatusRow[];
  plan: ServerStatus["plan"] | null;
  ahood: AhoodStatusBlock | null;
  notices: CliNotice[];
}> {
  migrateProjectLockfileOrWarn();
  const items = readInstalled().items;
  if (items.length === 0) return { items, rows: [], plan: null, ahood: null, notices: [] };
  const { byKey, plan, ahood, notices } = await fetchStatus(items);
  const mismatched = reconcileSkillIds(items, byKey);
  return {
    items,
    rows: items.map((i) =>
      toRow(i, byKey.get(itemKey(i).toLowerCase()), mismatched.has(`${i.projectDir}::${itemKey(i).toLowerCase()}`)),
    ),
    plan,
    ahood,
    notices,
  };
}

function pad(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
}

function stateOf(r: StatusRow): string {
  if (r.status === "not_found") return "not found in registry";
  // ahood-cli#1320 contract §5: checked before "files missing" -- a
  // mismatched skillId is the more actionable fact, and the warning
  // already printed above the table says why.
  if (r.skill_id_mismatch) return "blocked -- now a different skill";
  if (r.missing) return "files missing";
  if (r.pinned !== null) return r.sync_target ? `pinned @${r.pinned} (sync moves to it)` : `pinned @${r.pinned}`;
  return r.update_available ? "update available" : "up to date";
}

export async function status(args: string[]): Promise<void> {
  const leftover = unrecognizedArgs(args, ["--json"], []);
  if (leftover.length > 0) throw new UsageError(`Unknown argument: ${leftover[0]}\n${USAGE}`);
  const json = args.includes("--json");

  const { rows, plan, ahood, notices } = await loadStatusRows();
  // ahood#1552 step 5: status sees the server's own `ahood.client` block (if
  // and when the server sends one -- optional, see AhoodStatusBlock above),
  // so it calls the shared notifier directly with that fresher data instead
  // of the generic post-command call index.ts makes for every other
  // command (which only has the local npm-registry cache). Absent the
  // block, this behaves exactly like the generic call: `latest`/
  // `belowMinimum` fall back to undefined/false and the cache is used.
  maybeNotifyUpdate({ json, belowMinimum: ahood?.client?.below_minimum, latest: ahood?.client?.latest });
  // ahood#1554 step 5: the highest-severity notice[] the server sent, one
  // stderr line, same spirit as the update notice above (never a blocking
  // or --json-breaking message).
  const notice = json ? null : highestSeverityNotice(notices);
  if (notice) console.error(noticeAnnouncementLine(notice));
  if (json) {
    console.log(JSON.stringify({ items: rows, plan, ahood, notices }));
    return;
  }
  if (rows.length === 0) {
    console.log("Nothing installed with ahood yet. Install something with `ahood skill add <owner>/<slug>`.");
    return;
  }

  const header = ["ARTIFACT", "KIND", "INSTALLED", "LATEST", "STATE", "PATH"];
  const table = rows.map((r) => [itemKey(r), r.kind ?? "?", r.installed_version, r.latest_version ?? "-", stateOf(r), r.installed_path]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
  console.log(pad(header, widths));
  for (const t of table) console.log(pad(t, widths));

  const updates = rows.filter((r) => r.sync_target !== null && !r.missing);
  const missing = rows.filter((r) => r.missing && r.status === "ok");
  // A row the table flags (files gone, not in the registry, or blocked by a
  // skillId mismatch -- ahood-cli#1320 contract §5) is not "up to date".
  const flagged = rows.some((r) => r.missing || r.status === "not_found" || r.skill_id_mismatch);
  console.log("");
  if (updates.length > 0) console.log(`${updates.length} update(s) available -- run \`ahood sync\` to review and apply them.`);
  else if (!flagged) console.log("Everything is up to date.");
  for (const r of missing) {
    console.log(`${itemKey(r)}: files missing from ${r.installed_path} -- reinstall with \`ahood ${r.kind ?? "skill"} add ${itemKey(r)}\`.`);
  }

  const own = new Map<string, StatusRow>();
  for (const r of rows) if (r.is_owner && r.evolution && !own.has(itemKey(r))) own.set(itemKey(r), r);
  if (own.size === 0) return;
  console.log("");
  console.log("Your artifacts (self-evolution):");
  let pending = 0;
  for (const [key, r] of own) {
    const e = r.evolution!;
    pending += e.pending_proposals;
    const mode = e.enabled ? `on, ${e.promotion_mode} mode, probe ${e.probe_mode}` : "off";
    console.log(`  ${key}: evolution ${mode}; ${e.pending_proposals} pending proposal(s)`);
  }
  if (plan && !plan.evolution_available) console.log("  Self-evolution needs a Pro plan.");
  else if (plan && !plan.consented) console.log("  Self-evolution is not switched on for your account yet (owner consent not given).");
  if (pending > 0) console.log(`  Run \`ahood review\` to approve or reject ${pending} pending proposal(s).`);
}
