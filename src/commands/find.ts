// `ahood find` (ahood#1019): discovery across every kind, the front door the
// /ahood-find and /ahood-trending commands call. Not a second search: the
// request is search.ts's searchSkills (GET /api/v1/skills), with the kind and
// sort the browse route already honours; this file only parses flags and
// prints one line per result with the fields a chooser needs.
import { flagValue, unrecognizedArgs } from "../flags.js";
import { CLI_KINDS, isCliKind, KINDS, type CliKind } from "../kinds.js";
import { sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";
import { SEARCH_SORTS, searchSkills, type SearchRow, type SearchSort } from "./search.js";

const USAGE = `Usage: ahood find [<query>] [--kind ${CLI_KINDS.join("|")}] [--sort ${SEARCH_SORTS.join("|")}] [--limit <n>] [--json]`;

/** One result as `ahood find --json` prints it. */
export type FindResult = {
  ref: string;
  owner: string | null;
  slug: string;
  kind: string | null;
  name: string;
  tagline: string | null;
  stars: number | null;
  downloads: number;
  /** The browse route does not select updated_at today; null until it does. */
  updated_at: string | null;
};

export function toFindResult(row: SearchRow): FindResult {
  const owner = row.profiles?.username ?? null;
  return {
    ref: `${owner ?? "(unknown)"}/${row.slug}`,
    owner,
    slug: row.slug,
    kind: row.kind ?? null,
    name: row.name,
    tagline: row.tagline,
    stars: row.stars_count ?? null,
    downloads: row.downloads_count,
    updated_at: row.updated_at ?? null,
  };
}

function formatLine(r: FindResult): string {
  const s = (v: unknown) => sanitizeForTerminal(v);
  const purpose = r.tagline ? s(r.tagline) : s(r.name);
  const counts = [`${r.stars ?? "?"} stars`, `${r.downloads} downloads`];
  if (r.updated_at) counts.push(`updated ${s(r.updated_at.slice(0, 10))}`);
  return `${s(r.ref)}  [${s(r.kind ?? "?")}]  ${purpose}  (${counts.join(", ")})`;
}

export async function find(args: string[]): Promise<void> {
  const kindArg = flagValue(args, "--kind");
  const sortArg = flagValue(args, "--sort");
  const limitArg = flagValue(args, "--limit");
  const positionals = unrecognizedArgs(args, ["--json"], ["--kind", "--sort", "--limit"]);
  const unknownFlag = positionals.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${USAGE}`);

  if (kindArg !== undefined && !isCliKind(kindArg)) {
    throw new UsageError(`--kind must be one of: ${CLI_KINDS.join(", ")} (got "${kindArg}").\n${USAGE}`);
  }
  if (sortArg !== undefined && !(SEARCH_SORTS as readonly string[]).includes(sortArg)) {
    throw new UsageError(`--sort must be one of: ${SEARCH_SORTS.join(", ")} (got "${sortArg}").\n${USAGE}`);
  }
  if (limitArg !== undefined && (!/^\d+$/.test(limitArg) || Number(limitArg) < 1 || Number(limitArg) > 50)) {
    throw new UsageError(`--limit must be an integer from 1 to 50 (got "${limitArg}").\n${USAGE}`);
  }
  const kind = kindArg as CliKind | undefined;
  const sort = sortArg as SearchSort | undefined;
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  const query = positionals.join(" ");
  // A browse with nothing to narrow it would be the whole registry in rank
  // order -- allowed, but only when asked for by a sort or a kind.
  if (query === "" && kind === undefined && sort === undefined) throw new UsageError(USAGE);

  const results = (await searchSkills(query, limit, kind, sort)).map(toFindResult);

  if (args.includes("--json")) {
    console.log(JSON.stringify(results));
    return;
  }
  if (results.length === 0) {
    console.log(kind ? `No ${KINDS[kind].plural} found.` : "Nothing found.");
    return;
  }
  for (const r of results) console.log(formatLine(r));
  console.log("");
  console.log("Read one without installing: `ahood try <owner>/<slug>`. Install: `ahood <kind> add <owner>/<slug>`.");
}
