// Kind-aware registry commands (ahood-cli#172): scope resolution and the
// wrong-kind guards every kind-scoped verb runs before its first side effect.
// The kind table itself lives in kind-info.ts.
import { existsSync } from "node:fs";
import { apiJson } from "./http.js";
import { agentPath, skillDir } from "./spec.js";
import type { LockEntry } from "./lockfile.js";
import { UsageError } from "./usage-error.js";
import { KINDS, CLI_KINDS, isCliKind, type CliKind } from "./kind-info.js";
export { KINDS, CLI_KINDS, isCliKind, type CliKind };

// The scope a registry verb runs under.
//
//   kind "all"  -- the legacy, cross-kind behavior `ahood skill <verb>` has
//                  always had (and still has by default in this release).
//   kind <k>    -- strict: `ahood agent <verb>`, `ahood mcp <verb>`, or any
//                  noun with an explicit `--kind <k>`. A strict verb refuses
//                  an entry of another kind before it has any side effect.
//
// `noun` is the word the user typed (for messages); it is not the kind.
export type KindScope = { noun: CliKind; kind: CliKind | "all" };

export const LEGACY_SCOPE: KindScope = { noun: "skill", kind: "all" };

export function strictKind(scope: KindScope | undefined): CliKind | undefined {
  return scope && scope.kind !== "all" ? scope.kind : undefined;
}

// A wrong-kind target: the user pointed a noun at the wrong kind of entry, so
// it maps to exit 2 ("fix your input") through UsageError, the same code a
// server-side validation refusal gets.
export class KindMismatchError extends UsageError {}

export function describeKind(kind: CliKind): string {
  return `${KINDS[kind].article} ${KINDS[kind].label}`;
}

// Throws unless `actual` is the scope's kind. A no-op for the legacy scope.
//
// Missing or unrecognized kind metadata is refused, never guessed: the legacy
// code treated a missing `kind` as a skill, and a strict verb that did the
// same would silently misclassify exactly the entry it exists to protect.
// That refusal is a plain Error (exit 1) rather than a KindMismatchError,
// since nothing about the user's input is wrong -- the registry's answer is.
export function assertKind(
  scope: KindScope | undefined,
  key: string,
  actual: unknown,
  verb: string,
  action: string,
): void {
  const expected = strictKind(scope);
  if (expected === undefined || actual === expected) return;
  const legacyHint = `\`ahood skill ${verb} ${key}\` (legacy, any kind)`;
  if (isCliKind(actual)) {
    throw new KindMismatchError(
      `${key} is ${describeKind(actual)}, not ${describeKind(expected)} -- refusing to ${action} it. ` +
        `Use \`ahood ${actual} ${verb} ${key}\` instead.`,
    );
  }
  if (actual === undefined || actual === null || actual === "") {
    throw new Error(
      `The registry did not report a kind for ${key}, so ahood cannot confirm it is ${describeKind(expected)} -- ` +
        `refusing to ${action} it. If you are sure, use ${legacyHint}.`,
    );
  }
  throw new Error(
    `${key} has kind "${String(actual).slice(0, 40)}", which \`ahood ${scope!.noun}\` does not handle -- ` +
      `refusing to ${action} it. Use ${legacyHint} if you really mean it.`,
  );
}

// Resolves an existing registry entry's kind and asserts it, for verbs whose
// own request carries no kind (star, share, edit, versions, ...). A no-op --
// and, importantly, no extra request -- for the legacy scope, so
// `ahood skill <verb>` sends exactly what it always has.
export async function ensureRemoteKind(
  scope: KindScope | undefined,
  owner: string,
  skill: string,
  verb: string,
  action: string,
): Promise<void> {
  if (strictKind(scope) === undefined) return;
  const detail = await apiJson<{ kind?: unknown }>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
  );
  assertKind(scope, `${owner}/${skill}`, detail.kind, verb, action);
}

// What this project's own files say an installed pin is, without asking the
// registry. The lockfile records no `kind` (and this change does not migrate
// it), so the footprint each kind leaves is the evidence:
//   skill -> a .claude/skills/<owner>@<skill>/ directory
//   agent -> a .claude/agents/<owner>@<skill>.md file
//   mcp   -> neither, plus the mcp_config_hash only an mcp install records
// Anything else (both, or a bare pin with no hash -- a legacy mcp pin or a
// skill whose directory was deleted by hand) is undefined: unknown, and the
// caller must ask the registry rather than guess.
export function localInstalledKind(owner: string, skill: string, entry: LockEntry | undefined): CliKind | undefined {
  const hasDir = existsSync(skillDir(owner, skill));
  const hasAgentFile = existsSync(agentPath(owner, skill));
  if (hasDir && !hasAgentFile) return "skill";
  if (hasAgentFile && !hasDir) return "agent";
  if (!hasDir && !hasAgentFile && entry?.mcp_config_hash !== undefined) return "mcp";
  return undefined;
}

// Pulls `--kind <value>` / `--kind=<value>` out of a registry verb's args.
// Returns the remaining args untouched otherwise, so a handler never sees a
// flag it does not declare.
export function extractKindFlag(args: string[]): { kind: string | undefined; rest: string[] } {
  let kind: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      if (kind !== undefined) throw new UsageError("--kind given more than once. Pass it once.");
      if (arg === "--kind") {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) throw new UsageError("--kind requires a value.");
        kind = value;
        i++;
      } else {
        kind = arg.slice("--kind=".length);
      }
      continue;
    }
    rest.push(arg);
  }
  return { kind, rest };
}

// Resolves the scope for `ahood <noun> <verb> [--kind <k>]`.
//   skill noun, no --kind or --kind all  -> legacy (cross-kind)
//   skill noun, --kind <k>               -> strict <k>
//   agent/mcp noun, no --kind or --kind <same> -> strict <noun>
//   agent/mcp noun, any other --kind     -> usage error (contradiction)
export function resolveScope(noun: CliKind, kindFlag: string | undefined): KindScope {
  const valid = [...CLI_KINDS, "all"].join(", ");
  if (kindFlag !== undefined && kindFlag !== "all" && !isCliKind(kindFlag)) {
    throw new UsageError(`--kind must be one of: ${valid} (got "${kindFlag}").`);
  }
  if (noun === "skill") {
    return kindFlag === undefined || kindFlag === "all" ? LEGACY_SCOPE : { noun, kind: kindFlag as CliKind };
  }
  if (kindFlag !== undefined && kindFlag !== noun) {
    throw new UsageError(
      `\`ahood ${noun}\` only operates on ${KINDS[noun].plural} -- --kind ${kindFlag} contradicts it. ` +
        (kindFlag === "all"
          ? "Use `ahood skill <verb>` (legacy, any kind) for a cross-kind operation."
          : `Use \`ahood ${kindFlag} <verb>\` instead.`),
    );
  }
  return { noun, kind: noun };
}
