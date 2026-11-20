// @ahood/opencode-plugin (ahood#1009): ahood as an opencode v2 server plugin.
// It registers the /ahood commands, the hosted `ahood` MCP server, the
// opt-in snap prompt and the session notice (ahood#1565 item 1). Every word
// it sends comes from ./generated.ts, rendered from the CLI's shared
// templates (src/setup/templates/opencode-plugin.ts in the ahood-cli repo);
// what each opencode API call does, and how that was verified, is written
// down there too.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_HEADER_NAME,
  CLIENT_HEADER_VALUE,
  COMMANDS,
  MCP_SERVER_NAME,
  MCP_URL,
  NOTICE_OPT_OUT_ENV,
  PLUGIN_ID,
  SNAP_HOOK_ENV,
  SNAP_PROMPT,
  STATUS_ARGV,
  STATUS_BUDGET_MS,
  TOKEN_ENV,
} from "./generated.js";
import type { OpencodeEvent, Plugin, PluginContext, RemoteMcpConfig } from "./opencode-api.js";

type Env = Record<string, string | undefined>;

// ahood#1565 item 1: the shape of one entry of the server's `ahood_status
// --json` response's `notices[]` (web lib/notices/select.ts's
// DeliveredNotice, already audience-filtered and de-duplicated
// server-side) -- the same fields src/update-notifier.ts's CliNotice reads
// on the bare CLI side. Copied rather than imported: this package ships
// standalone to npm (tsconfig's rootDir is this package's own src/), so it
// reads nothing outside itself.
type CliNoticeSeverity = "info" | "action" | "required";
type CliNotice = { severity: CliNoticeSeverity; message: string };
type StatusResponse = { notices?: CliNotice[] };
const SEVERITY_RANK: Record<CliNoticeSeverity, number> = { required: 2, action: 1, info: 0 };

/** The one notice worth leading with, or null for an empty/absent list. Ties keep the first (server order). */
function highestSeverityNotice(notices: CliNotice[]): CliNotice | null {
  if (notices.length === 0) return null;
  return notices.reduce((best, n) => ((SEVERITY_RANK[n.severity] ?? 0) > (SEVERITY_RANK[best.severity] ?? 0) ? n : best));
}

/** A command's prompt with the user's arguments in place of $ARGUMENTS, as opencode does for file commands. */
export function renderTemplate(template: string, args: string): string {
  return template.split("$ARGUMENTS").join(args.trim());
}

// The token is read from the environment opencode runs in, like the
// `{env:AHOOD_TOKEN}` reference a config file would hold, and never written
// anywhere. A user's own `mcp.servers.ahood` (e.g. the one `ahood setup
// opencode --store-token` writes) is already in the editor and wins.
export function mcpEntry(env: Env): RemoteMcpConfig {
  return {
    type: "remote",
    url: MCP_URL,
    // ahood#1552 step 6: alongside Authorization, identifies this as the
    // opencode plugin (vs. the bare CLI's User-Agent, or Claude Code's/
    // Codex's own plugin header) to the server.
    headers: { Authorization: `Bearer ${env[TOKEN_ENV] ?? ""}`, [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE },
  };
}

/** True only for AHOOD_SNAP_HOOK=1, the same switch as the Claude Code plugin's Stop hook. */
export function snapHookEnabled(env: Env): boolean {
  return env[SNAP_HOOK_ENV] === "1";
}

/**
 * The session notice is on by default (like the Claude Code plugin's
 * SessionStart hook); AHOOD_NO_UPDATE_NOTIFIER=1 turns it off -- the one
 * opt-out this family of passive ahood notices already shares (the CLI's
 * own passive update notifier, src/update-notifier.ts). The Claude Code
 * hook itself checks no env switch today, so there is nothing else to
 * mirror from it.
 */
export function noticeOptedOut(env: Env): boolean {
  return env[NOTICE_OPT_OUT_ENV] === "1";
}

function markerPath(dir: string, sessionID: string, kind: string): string {
  return join(dir, `${kind}-${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}

/** True the first time `kind` is claimed for `sessionID` in `dir`, false after (also across opencode restarts, via a marker file). */
function claimOnce(dir: string, sessionID: string, kind: string): boolean {
  const marker = markerPath(dir, sessionID, kind);
  if (existsSync(marker)) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims the once-per-session snap prompt for `sessionID`: true the first
 * time, false after (also across opencode restarts, via a marker file). A
 * marker that cannot be written means no once-per-session guarantee, so
 * nothing is asked at all.
 */
export function claimSnapPrompt(dir: string, sessionID: string): boolean {
  return claimOnce(dir, sessionID, "opencode-prompted");
}

/** Claims the once-per-session notice check for `sessionID`; same guarantee as claimSnapPrompt. */
export function claimSessionNotice(dir: string, sessionID: string): boolean {
  return claimOnce(dir, sessionID, "opencode-notice");
}

/**
 * Runs the pinned CLI's `status --json` -- the same command and flags the
 * Claude Code plugin's SessionStart hook runs (ahood-cli #237) -- with a
 * STATUS_BUDGET_MS timeout. Async and never thrown out of: no token, no
 * network, a timeout, a non-zero exit or a malformed response all resolve
 * to null, so a caller on the event-handling path never blocks or throws.
 */
export function runStatusCheck(env: Env): Promise<StatusResponse | null> {
  return new Promise((resolve) => {
    try {
      execFile(STATUS_ARGV[0], STATUS_ARGV.slice(1), { timeout: STATUS_BUDGET_MS, env: env as NodeJS.ProcessEnv }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as StatusResponse);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** The synthetic message text for the highest-severity notice, or null when there is nothing worth telling the agent. */
export function buildNoticeMessage(status: StatusResponse | null): string | null {
  const notices = Array.isArray(status?.notices) ? (status as StatusResponse).notices! : [];
  const top = highestSeverityNotice(notices);
  if (!top) return null;
  return `ahood: Notice (${top.severity}): ${top.message}. Tell the user in one line and suggest \`/ahood sync\` (and \`npx @ahood/cli@latest setup\` for the CLI); never run them yourself.`;
}

/**
 * When a turn ends in a top-level session, once per session: queue the snap
 * prompt as a synthetic message, which resumes the session with it. The
 * resumed turn ending again finds the marker, so it never loops. Subagent
 * sessions are skipped -- the prompt belongs to the conversation the user has.
 */
async function handleSnapEvent(context: PluginContext, markerDir: string, event: OpencodeEvent): Promise<void> {
  const sessionID = event.data?.sessionID;
  if (!sessionID) return;
  try {
    const session = await context.session.get({ sessionID });
    if (session?.parentID) return;
    if (!claimSnapPrompt(markerDir, sessionID)) return;
    await context.session.synthetic({ sessionID, text: SNAP_PROMPT, description: "ahood snap prompt" });
  } catch {
    // A failed reminder must never get in the way of the session.
  }
}

/**
 * On a new top-level session (`session.created`, the earliest event
 * opencode fires for a session -- `data.parentID` is set only for a
 * sub-agent one, so no extra `session.get` round trip is needed), once per
 * session: run the status check and, only if the server returned a notice,
 * queue it as a synthetic message. Never blocks the session -- the check
 * runs async -- and never surfaces an error.
 */
async function handleSessionCreated(context: PluginContext, markerDir: string, env: Env, event: OpencodeEvent): Promise<void> {
  const sessionID = event.data?.sessionID;
  if (!sessionID || event.data?.parentID) return;
  try {
    if (!claimSessionNotice(markerDir, sessionID)) return;
    const message = buildNoticeMessage(await runStatusCheck(env));
    if (!message) return;
    await context.session.synthetic({ sessionID, text: message, description: "ahood session notice" });
  } catch {
    // A failed check must never get in the way of the session.
  }
}

async function runEventLoop(
  context: PluginContext,
  opts: { env: Env; markerDir: string; snapOn: boolean; noticeOn: boolean },
  signal: AbortSignal,
): Promise<void> {
  for await (const event of context.event.subscribe({ signal })) {
    if (opts.snapOn && event.type === "session.execution.succeeded") await handleSnapEvent(context, opts.markerDir, event);
    if (opts.noticeOn && event.type === "session.created") await handleSessionCreated(context, opts.markerDir, opts.env, event);
  }
}

export type PluginOptions = { env?: Env; markerDir?: string };

export function createPlugin(options: PluginOptions = {}): Plugin {
  const env = options.env ?? process.env;
  const markerDir = options.markerDir ?? join(tmpdir(), "ahood-snap-hook");
  return {
    id: PLUGIN_ID,
    async setup(context) {
      await context.command.transform((editor) => {
        for (const command of COMMANDS) {
          editor.add({
            name: command.name,
            description: command.description,
            execute: async (input) => {
              await context.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: renderTemplate(command.template, input.prompt.text),
                delivery: input.delivery,
              });
            },
          });
        }
      });
      await context.mcp.transform((editor) => {
        if (editor.get(MCP_SERVER_NAME) === undefined) editor.set(MCP_SERVER_NAME, mcpEntry(env));
      });
      const snapOn = snapHookEnabled(env);
      const noticeOn = !noticeOptedOut(env);
      // Both off, nothing listens at all: the Stop-hook-equivalent is
      // opt-in, and the session notice's own opt-out covers the rest.
      if (!snapOn && !noticeOn) return;
      const stop = new AbortController();
      void runEventLoop(context, { env, markerDir, snapOn, noticeOn }, stop.signal).catch(() => {});
      return () => stop.abort();
    },
  };
}

export default createPlugin();
