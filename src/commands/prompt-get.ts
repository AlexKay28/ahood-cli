// `ahood prompt get <owner>/<slug>[@version] [--<key> value ...] [--copy] [--json]`
// (ahood-cli#206, AlexKay28/ahood#1007): read a prompt's PROMPT.md, fill its
// {{key}} placeholders, and print the text -- and nothing else -- to stdout,
// so `| pbcopy` and `> prompt.txt` both work. A prompt is never installed, so
// this is its one consuming verb; add/update/outdated/remove are refused in
// the dispatcher.
//
// Same read path as `ahood <kind> read` (GET /api/v1/skills/{owner}/{slug},
// or .../versions/{version} for a pinned version), and the same parser and
// filler as the server (src/prompt-doc.ts). The errors are worded exactly as
// the hosted get_prompt MCP tool words them (ahood repo,
// lib/prompts/get-prompt.ts), and --json prints that tool's payload.
import { spawnSync } from "node:child_process";
import { apiJson } from "../http.js";
import { parseOwnerSkillVersion } from "../spec.js";
import { sanitizeDocumentForTerminal, sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";
import { assertKind, type KindScope } from "../kinds.js";
import { fillPrompt, parsePromptDoc, type PromptInput } from "../prompt-doc.js";

const USAGE = "Usage: ahood prompt get <owner>/<prompt>[@version] [--<key> <value> ...] [--copy] [--json]";

const SCOPE: KindScope = { noun: "prompt", kind: "prompt" };

// `get` owns exactly --copy and --json. Every other `--<name>` is an input;
// `--copy=x` / `--json=x` still set an input named copy/json, so every
// declared key stays settable.
type GetArgs = { spec: string; values: Record<string, string>; copy: boolean; json: boolean };

export function parsePromptGetArgs(args: string[]): GetArgs {
  let spec: string | undefined;
  const values: Record<string, string> = {};
  let copy = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--copy") copy = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      let key: string;
      let value: string | undefined;
      if (eq !== -1) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        value = args[i + 1];
        // A following flag is not a value, the same rule as --kind's
        // (kinds.ts extractKindFlag); `--key=--x` passes one that starts with --.
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError(`--${key} requires a value (use --${key}=<value> for one that starts with --).\n${USAGE}`);
        }
        i++;
      }
      if (key.length === 0) throw new UsageError(`Empty input name in "${arg}".\n${USAGE}`);
      if (Object.hasOwn(values, key)) throw new UsageError(`--${key} given more than once. Pass it once.`);
      values[key] = value;
    } else if (spec === undefined && !arg.startsWith("-")) spec = arg;
    else throw new UsageError(`Unexpected argument "${arg}".\n${USAGE}`);
  }
  if (spec === undefined) throw new UsageError(USAGE);
  if (copy && json) throw new UsageError(`Pass --copy or --json, not both.\n${USAGE}`);
  return { spec, values, copy, json };
}

// What both read routes return, narrowed to what this command uses: the
// detail route nests the latest version under skill_versions, the version
// route is the version row itself (plus the entry's kind).
type DetailResponse = {
  owner?: string;
  slug?: string;
  kind?: unknown;
  skill_versions: VersionRow | null;
};
type VersionRow = {
  version: string;
  status?: string;
  skill_md_content: string | null;
  yanked_at?: string | null;
  yanked_reason?: string | null;
};

async function fetchPromptMd(owner: string, slug: string, version: string): Promise<{ owner: string; slug: string; row: VersionRow }> {
  const base = `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
  const key = `${owner}/${slug}`;
  let row: VersionRow | null;
  let kind: unknown;
  let canonical = { owner, slug };
  if (version === "latest") {
    const detail = await apiJson<DetailResponse>(base);
    kind = detail.kind;
    row = detail.skill_versions;
    canonical = { owner: detail.owner ?? owner, slug: detail.slug ?? slug };
  } else {
    const versionRow = await apiJson<VersionRow & { kind?: unknown }>(`${base}/versions/${encodeURIComponent(version)}`);
    kind = versionRow.kind;
    row = versionRow;
  }
  // A processing/failed version row carries only {version, status,
  // failure_reason} -- no kind to check, and nothing to fill.
  if (!row || (row.status !== undefined && row.status !== "published")) {
    throw new Error(`${key}${version === "latest" ? "" : `@${version}`} has no published version.`);
  }
  // "read", not "get", in the pointer: no other kind has a `get` verb.
  assertKind(SCOPE, key, kind, "read", "fill");
  if (row.yanked_at) {
    console.warn(
      `WARNING: ${key}@${row.version} has been yanked${row.yanked_reason ? `: ${sanitizeForTerminal(row.yanked_reason)}` : "."}`,
    );
  }
  if (!row.skill_md_content) throw new Error(`${key}@${row.version} has no PROMPT.md content available.`);
  return { ...canonical, row };
}

// Clipboard tools, in the order tried: macOS, Windows, Wayland, X11. Missing
// ones (ENOENT) and failing ones (wl-copy outside a Wayland session) both
// fall through to the next; only when none worked is it an error.
export const CLIPBOARD_COMMANDS: ReadonlyArray<readonly [string, ...string[]]> = [
  ["pbcopy"],
  ["clip"],
  ["wl-copy"],
  ["xclip", "-selection", "clipboard"],
];

function copyToClipboard(text: string): string {
  const failures: string[] = [];
  for (const [command, ...commandArgs] of CLIPBOARD_COMMANDS) {
    const result = spawnSync(command, commandArgs, { input: text, stdio: ["pipe", "ignore", "pipe"], timeout: 10_000 });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (!result.error && result.status === 0) return command;
    failures.push(`${command} (${result.error ? result.error.message : `exit ${result.status}`})`);
  }
  throw new Error(
    failures.length > 0
      ? `Could not copy to the clipboard: ${failures.join(", ")} failed. Drop --copy to print the prompt instead.`
      : "Could not copy to the clipboard: none of pbcopy, clip, wl-copy or xclip is installed. Drop --copy to print the prompt instead.",
  );
}

// Reached only as `ahood prompt get`, so its scope is always SCOPE.
export async function promptGet(args: string[]): Promise<void> {
  const { spec, values, copy, json } = parsePromptGetArgs(args);
  const { owner, skill, version } = parseOwnerSkillVersion(spec, USAGE);
  const fetched = await fetchPromptMd(owner, skill, version);
  const key = `${owner}/${skill}`;

  const parsed = parsePromptDoc(fetched.row.skill_md_content!);
  if (!parsed.ok) throw new Error(`${key}@${fetched.row.version}: stored ${parsed.reason}`);
  const { prompt } = parsed;

  const declared = prompt.inputs.map((input) => input.key);
  const unknown = Object.keys(values).filter((k) => !declared.includes(k));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown input${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}; this prompt declares ${declared.join(", ") || "none"}`,
    );
  }
  const filled = fillPrompt(prompt, values);
  if (!filled.ok) {
    const labelled = filled.missing.map((k) => `${k} (${prompt.inputs.find((input) => input.key === k)?.label ?? k})`);
    throw new UsageError(`Missing required input${filled.missing.length > 1 ? "s" : ""}: ${labelled.join(", ")}`);
  }

  if (json) {
    const payload: {
      owner: string;
      slug: string;
      name: string;
      intent: string;
      version: string;
      inputs: PromptInput[];
      works_with: string[];
      text: string;
    } = {
      owner: fetched.owner,
      slug: fetched.slug,
      name: prompt.name,
      intent: prompt.intent,
      version: fetched.row.version,
      inputs: prompt.inputs,
      works_with: prompt.worksWith,
      text: filled.text,
    };
    console.log(JSON.stringify(payload));
    return;
  }

  if (copy) {
    const tool = copyToClipboard(filled.text);
    console.error(`Copied ${key}@${fetched.row.version} to the clipboard (${tool}).`);
    return;
  }

  // Raw bytes to a pipe, sanitized on a terminal -- the same split, for the
  // same reason, as `ahood <kind> read` (read.ts, ahood-cli#90/#133): the
  // body is publisher-controlled text.
  process.stdout.write(process.stdout.isTTY ? sanitizeDocumentForTerminal(filled.text) : filled.text);
}
