import { apiJson } from "../http.js";
import { askLine, isInteractive } from "../confirm.js";
import { flagValue, unrecognizedArgs } from "../flags.js";
import { SEMVER_RE } from "../spec.js";
import { sanitizeDocumentForTerminal, sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";

const LIST_USAGE = "Usage: ahood review [--limit <n>] [--json]";
const APPROVE_USAGE = "Usage: ahood review approve <id> [--version <semver>] [--json]";
const REJECT_USAGE = "Usage: ahood review reject <id> [--json]";

// `ahood review` (ahood#979): the owner's queue of pending self-evolution
// proposals, from GET /api/v1/me/proposals (ahood#978,
// lib/enhancements/owner-proposals.ts), decided with
// POST /api/v1/me/proposals/{id}/approve|reject -- the same decision the web
// owner panel makes. Listing needs the token's 'read' scope; deciding needs
// 'publish'. In a terminal, bare `ahood review` walks the queue asking
// approve/reject/skip per proposal; piped, it only lists.

// Mirrors OwnerProposal (EvolutionInboxItem + evidence) -- only the fields read here.
export type Proposal = {
  candidate_id: string;
  created_at: string;
  expires_at: string;
  expired: boolean;
  artifact: { id: string; name: string | null; slug: string | null; kind: string | null; available: boolean };
  owner: string | null;
  base_version: string | null;
  current_version: string | null;
  base_is_current: boolean;
  suggested_version: string | null;
  version_input_required: boolean;
  checks: string;
  rationale: string | null;
  sandbox_result: string | null;
  risk_findings_count: number;
  probe_result: string | null;
  promotion_mode: string;
  held_reason: string | null;
  review_path: string | null;
};
export type ProposalPage = { total: number; items: Proposal[]; next_cursor: string | null };
export type DecisionBody = { status: "promoting" | "stale" | "rejected"; versionId?: string; reason?: string };

/** Pages followed when no --limit is given: 20 x the server's default 25. */
const MAX_PAGES = 20;

const proposalPath = (id: string, verb: "approve" | "reject") => `/api/v1/me/proposals/${encodeURIComponent(id)}/${verb}`;

export async function fetchProposals(limit: number | undefined): Promise<ProposalPage> {
  const items: Proposal[] = [];
  let cursor: string | null = null;
  let total = 0;
  for (let page = 0; page < (limit === undefined ? MAX_PAGES : 1); page++) {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    const q = qs.toString();
    const res: ProposalPage = await apiJson<ProposalPage>(`/api/v1/me/proposals${q ? `?${q}` : ""}`);
    items.push(...res.items);
    total = res.total;
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return { total, items, next_cursor: cursor };
}

function artifactName(p: Proposal): string {
  const slug = p.artifact.slug ?? p.artifact.id;
  return sanitizeForTerminal(p.owner ? `${p.owner}/${slug}` : slug);
}

function describe(p: Proposal): string[] {
  const s = (v: unknown) => sanitizeForTerminal(v);
  const target = p.suggested_version ?? (p.version_input_required ? "(you choose the version)" : "?");
  const lines = [
    `${s(p.candidate_id)}  ${artifactName(p)}  ${s(p.base_version ?? "?")} -> ${s(target)}`,
    `  checks: ${s(p.checks)}; sandbox: ${s(p.sandbox_result ?? "n/a")}; risk findings: ${p.risk_findings_count}; probe: ${s(p.probe_result ?? "off")}`,
    `  created ${s(p.created_at)}; review window ends ${s(p.expires_at)}${p.expired ? " (expired)" : ""}`,
  ];
  if (!p.base_is_current) lines.push(`  note: a newer version (${s(p.current_version ?? "?")}) is live; approving re-applies this proposal onto it.`);
  if (p.held_reason) lines.push(`  held from automatic promotion: ${s(p.held_reason)}`);
  if (p.rationale) lines.push(`  rationale: ${sanitizeDocumentForTerminal(p.rationale).replace(/\n/g, "\n    ")}`);
  if (p.review_path) lines.push(`  full diff: ${s(p.review_path)}`);
  return lines;
}

function describeDecision(id: string, body: DecisionBody): string {
  if (body.status === "rejected") return `Rejected ${id}.`;
  if (body.status === "promoting") return `Approved ${id}: publishing the new version now.`;
  return `Not published: ${id} is outdated (a newer version is live${body.reason ? `; ${sanitizeForTerminal(body.reason)}` : ""}).`;
}

export async function decide(id: string, verb: "approve" | "reject", version?: string): Promise<DecisionBody> {
  return apiJson<DecisionBody>(proposalPath(id, verb), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verb === "approve" && version ? { version } : {}),
  });
}

function parseId(args: string[], usage: string, valueFlags: string[]): string {
  const positionals = unrecognizedArgs(args, ["--json"], valueFlags);
  const unknownFlag = positionals.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${usage}`);
  if (positionals.length !== 1) throw new UsageError(usage);
  return positionals[0];
}

async function approveCommand(args: string[]): Promise<void> {
  const version = flagValue(args, "--version");
  if (version !== undefined && !SEMVER_RE.test(version)) {
    throw new UsageError(`--version must be a semver like 1.2.4 (got "${version}").\n${APPROVE_USAGE}`);
  }
  const id = parseId(args, APPROVE_USAGE, ["--version"]);
  const body = await decide(id, "approve", version);
  console.log(args.includes("--json") ? JSON.stringify({ id, ...body }) : describeDecision(id, body));
}

async function rejectCommand(args: string[]): Promise<void> {
  const id = parseId(args, REJECT_USAGE, []);
  const body = await decide(id, "reject");
  console.log(args.includes("--json") ? JSON.stringify({ id, ...body }) : describeDecision(id, body));
}

async function interactiveDecide(p: Proposal): Promise<"quit" | void> {
  for (;;) {
    const answer = (await askLine("[a]pprove, [r]eject, [s]kip, [q]uit? ")).toLowerCase();
    if (answer === "q" || answer === "quit") return "quit";
    if (answer === "" || answer === "s" || answer === "skip") return;
    if (answer === "r" || answer === "reject") {
      console.log(describeDecision(p.candidate_id, await decide(p.candidate_id, "reject")));
      return;
    }
    if (answer === "a" || answer === "approve") {
      let version: string | undefined;
      if (p.version_input_required || !p.suggested_version) {
        version = await askLine("Version to publish (semver): ");
        if (!SEMVER_RE.test(version)) {
          console.log(`"${sanitizeForTerminal(version)}" is not a semver -- skipped.`);
          return;
        }
      }
      console.log(describeDecision(p.candidate_id, await decide(p.candidate_id, "approve", version)));
      return;
    }
  }
}

async function listCommand(args: string[]): Promise<void> {
  const limitArg = flagValue(args, "--limit");
  const leftover = unrecognizedArgs(args, ["--json"], ["--limit"]);
  if (leftover.length > 0) throw new UsageError(`Unknown argument: ${leftover[0]}\n${LIST_USAGE}`);
  if (limitArg !== undefined && (!/^\d+$/.test(limitArg) || Number(limitArg) < 1 || Number(limitArg) > 100)) {
    throw new UsageError(`--limit must be an integer from 1 to 100 (got "${limitArg}").\n${LIST_USAGE}`);
  }
  const page = await fetchProposals(limitArg === undefined ? undefined : Number(limitArg));
  if (args.includes("--json")) {
    console.log(JSON.stringify(page));
    return;
  }
  if (page.items.length === 0) {
    console.log("No pending proposals.");
    return;
  }
  console.log(`${page.total} pending proposal(s):`);
  const interactive = isInteractive();
  for (const p of page.items) {
    console.log("");
    for (const line of describe(p)) console.log(line);
    if (interactive && (await interactiveDecide(p)) === "quit") return;
  }
  if (!interactive) {
    console.log("");
    console.log("Decide one with `ahood review approve <id>` or `ahood review reject <id>`.");
  }
}

export async function review(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === "approve") return approveCommand(rest);
  if (verb === "reject") return rejectCommand(rest);
  if (verb === "list") return listCommand(rest);
  return listCommand(args);
}
