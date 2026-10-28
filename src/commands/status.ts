import { existsSync } from "node:fs";
import { apiJson } from "../http.js";
import { unrecognizedArgs } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { itemKey, migrateProjectLockfileOrWarn, readInstalled, type InstalledItem } from "../installed.js";

const USAGE = "Usage: ahood status [--json]";

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
    };
export type ServerStatus = { items: ServerStatusItem[]; plan: { evolution_available: boolean; consented: boolean } };

/** The server's documented per-request cap (MAX_STATUS_ITEMS). */
export const STATUS_BATCH = 500;

/** One request per 500 distinct artifacts. The server answers per
 *  owner/slug; the installed version sent is the first install's, and
 *  update_available is recomputed per install by the caller (toRow). */
export async function fetchStatus(items: InstalledItem[]): Promise<{ byKey: Map<string, ServerStatusItem>; plan: ServerStatus["plan"] | null }> {
  const distinct = new Map<string, InstalledItem>();
  for (const item of items) {
    const key = itemKey(item).toLowerCase();
    if (!distinct.has(key)) distinct.set(key, item);
  }
  const unique = [...distinct.values()];
  const byKey = new Map<string, ServerStatusItem>();
  let plan: ServerStatus["plan"] | null = null;
  for (let i = 0; i < unique.length; i += STATUS_BATCH) {
    const batch = unique.slice(i, i + STATUS_BATCH);
    const res = await apiJson<ServerStatus>("/api/v1/me/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installed: batch.map((b) => ({ owner: b.owner, slug: b.slug, version: b.version })) }),
    });
    plan = res.plan;
    // The server lowercases owner/slug; match on that.
    for (const s of res.items) byKey.set(`${s.owner}/${s.slug}`.toLowerCase(), s);
  }
  return { byKey, plan };
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
};

/** What sync would move an install to: a pin holds it at the pinned version
 *  (moving there if it isn't on it yet), otherwise the latest. */
export function syncTarget(item: InstalledItem, latest: string | null): string | null {
  const target = item.pinned ?? latest;
  return target !== null && target !== item.version ? target : null;
}

export function toRow(item: InstalledItem, server: ServerStatusItem | undefined): StatusRow {
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
    sync_target: ok ? syncTarget(item, latest) : null,
    status: ok ? "ok" : "not_found",
    installed_path: item.installedPath,
    project_dir: item.projectDir,
    missing: !existsSync(item.installedPath),
    is_owner: ok?.is_owner ?? false,
    evolution: ok?.evolution ?? null,
  };
}

export async function loadStatusRows(): Promise<{ items: InstalledItem[]; rows: StatusRow[]; plan: ServerStatus["plan"] | null }> {
  migrateProjectLockfileOrWarn();
  const items = readInstalled().items;
  if (items.length === 0) return { items, rows: [], plan: null };
  const { byKey, plan } = await fetchStatus(items);
  return { items, rows: items.map((i) => toRow(i, byKey.get(itemKey(i).toLowerCase()))), plan };
}

function pad(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
}

function stateOf(r: StatusRow): string {
  if (r.status === "not_found") return "not found in registry";
  if (r.missing) return "files missing";
  if (r.pinned !== null) return r.sync_target ? `pinned @${r.pinned} (sync moves to it)` : `pinned @${r.pinned}`;
  return r.update_available ? "update available" : "up to date";
}

export async function status(args: string[]): Promise<void> {
  const leftover = unrecognizedArgs(args, ["--json"], []);
  if (leftover.length > 0) throw new UsageError(`Unknown argument: ${leftover[0]}\n${USAGE}`);
  const json = args.includes("--json");

  const { rows, plan } = await loadStatusRows();
  if (json) {
    console.log(JSON.stringify({ items: rows, plan }));
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
  console.log("");
  console.log(
    updates.length === 0
      ? "Everything is up to date."
      : `${updates.length} update(s) available -- run \`ahood sync\` to review and apply them.`,
  );

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
