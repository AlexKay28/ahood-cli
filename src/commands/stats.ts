// `ahood stats` (ahood#1019): the caller's own artifacts with their downloads
// and stars, the totals, recent activity, and the evolution counts a token can
// read. Every number comes from an existing route; nothing is computed here
// beyond the sums:
//   - GET /api/v1/profile                      -> the caller's username
//   - GET /api/v1/skills?mine=true             -> own artifacts (list.ts listOwnSkills)
//   - GET /api/v1/users/{me}/activity          -> recent activity log ({entries})
//   - GET /api/v1/enhancements/summary         -> {evolving_count, candidates_waiting}
// The evolution dashboard's yield numbers (tasks, no_change share, published
// versions) live at GET /api/v1/enhancements/analytics, which refuses a token
// (browser session only), so they are not fetched -- the output says where to
// see them instead.
import { apiJson } from "../http.js";
import { unrecognizedArgs } from "../flags.js";
import { sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";
import { listOwnSkills } from "./list.js";

const USAGE = "Usage: ahood stats [--json]";

/** Where the yield numbers the CLI cannot read live (the analytics route is session-only). */
export const EVOLUTION_DASHBOARD_NOTE =
  "Evolution yield (tasks, no-change share, published versions) is on the web dashboard only: https://www.ahood.dev/my-evolution";

// ahood lib/profile/activity.ts ActivityLogEntry.
export type ActivityEntry = { id: number; createdAt: string; text: string; href: string; category: string };
// ahood lib/enhancements/summary.ts EnhancementSummary.
export type EvolutionSummary = { evolving_count: number; candidates_waiting: number };

export type StatsArtifact = { ref: string; kind: string | null; visibility: string; downloads: number; stars: number };
export type Stats = {
  owner: string;
  totals: { artifacts: number; downloads: number; stars: number };
  artifacts: StatsArtifact[];
  activity: ActivityEntry[];
  /** null when the summary could not be read; the rest of the report still stands. */
  evolution: EvolutionSummary | null;
};

export async function loadStats(): Promise<Stats> {
  const { username } = await apiJson<{ username: string }>("/api/v1/profile");
  const own = await listOwnSkills();
  const artifacts = own
    .map((s) => ({
      ref: `${s.profiles?.username ?? username}/${s.slug}`,
      kind: s.kind ?? null,
      visibility: s.visibility,
      downloads: s.downloads_count ?? 0,
      stars: s.stars_count ?? 0,
    }))
    .sort((a, b) => b.downloads - a.downloads || b.stars - a.stars);
  const { entries } = await apiJson<{ entries: ActivityEntry[] }>(`/api/v1/users/${encodeURIComponent(username)}/activity`);
  // Best effort: a summary failure must not hide the numbers already read.
  const evolution = await apiJson<EvolutionSummary>("/api/v1/enhancements/summary").catch(() => null);
  return {
    owner: username,
    totals: {
      artifacts: artifacts.length,
      downloads: artifacts.reduce((n, a) => n + a.downloads, 0),
      stars: artifacts.reduce((n, a) => n + a.stars, 0),
    },
    artifacts,
    activity: entries ?? [],
    evolution,
  };
}

const ACTIVITY_SHOWN = 10;

export async function stats(args: string[]): Promise<void> {
  const leftover = unrecognizedArgs(args, ["--json"], []);
  if (leftover.length > 0) throw new UsageError(`Unknown argument: ${leftover[0]}\n${USAGE}`);
  const report = await loadStats();
  if (args.includes("--json")) {
    console.log(JSON.stringify(report));
    return;
  }
  const s = (v: unknown) => sanitizeForTerminal(v);
  const { totals } = report;
  console.log(`${s(report.owner)}: ${totals.artifacts} artifact(s), ${totals.downloads} downloads, ${totals.stars} stars`);
  if (report.artifacts.length > 0) {
    console.log("");
    for (const a of report.artifacts) {
      console.log(`  ${s(a.ref)}  [${s(a.kind ?? "?")}, ${s(a.visibility)}]  ${a.downloads} downloads, ${a.stars} stars`);
    }
  }
  console.log("");
  if (report.activity.length === 0) {
    console.log("No recent activity.");
  } else {
    console.log("Recent activity:");
    for (const e of report.activity.slice(0, ACTIVITY_SHOWN)) console.log(`  ${s(e.createdAt.slice(0, 10))}  ${s(e.text)}`);
  }
  console.log("");
  if (report.evolution) {
    console.log(
      `Self-evolution: ${report.evolution.evolving_count} artifact(s) evolving, ${report.evolution.candidates_waiting} proposal(s) waiting for review` +
        (report.evolution.candidates_waiting > 0 ? " (`ahood review`)." : "."),
    );
  }
  console.log(EVOLUTION_DASHBOARD_NOTE);
}
