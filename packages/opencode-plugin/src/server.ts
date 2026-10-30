// @ahood/opencode-plugin (ahood#1009): ahood as an opencode v2 server plugin.
// It registers the /ahood commands, the hosted `ahood` MCP server and the
// opt-in snap prompt. Every word it sends comes from ./generated.ts, rendered
// from the CLI's shared templates (src/setup/templates/opencode-plugin.ts in
// the ahood-cli repo); what each opencode API call does, and how that was
// verified, is written down there too.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, MCP_SERVER_NAME, MCP_URL, PLUGIN_ID, SNAP_HOOK_ENV, SNAP_PROMPT, TOKEN_ENV } from "./generated.js";
import type { Plugin, PluginContext, RemoteMcpConfig } from "./opencode-api.js";

type Env = Record<string, string | undefined>;

/** A command's prompt with the user's arguments in place of $ARGUMENTS, as opencode does for file commands. */
export function renderTemplate(template: string, args: string): string {
  return template.split("$ARGUMENTS").join(args.trim());
}

// The token is read from the environment opencode runs in, like the
// `{env:AHOOD_TOKEN}` reference a config file would hold, and never written
// anywhere. A user's own `mcp.servers.ahood` (e.g. the one `ahood setup
// opencode --store-token` writes) is already in the editor and wins.
export function mcpEntry(env: Env): RemoteMcpConfig {
  return { type: "remote", url: MCP_URL, headers: { Authorization: `Bearer ${env[TOKEN_ENV] ?? ""}` } };
}

/** True only for AHOOD_SNAP_HOOK=1, the same switch as the Claude Code plugin's Stop hook. */
export function snapHookEnabled(env: Env): boolean {
  return env[SNAP_HOOK_ENV] === "1";
}

function markerPath(dir: string, sessionID: string): string {
  return join(dir, `opencode-prompted-${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}

/**
 * Claims the once-per-session snap prompt for `sessionID`: true the first
 * time, false after (also across opencode restarts, via a marker file). A
 * marker that cannot be written means no once-per-session guarantee, so
 * nothing is asked at all.
 */
export function claimSnapPrompt(dir: string, sessionID: string): boolean {
  const marker = markerPath(dir, sessionID);
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
 * When a turn ends in a top-level session, once per session: queue the snap
 * prompt as a synthetic message, which resumes the session with it. The
 * resumed turn ending again finds the marker, so it never loops. Subagent
 * sessions are skipped -- the prompt belongs to the conversation the user has.
 */
async function runSnapHook(context: PluginContext, markerDir: string, signal: AbortSignal): Promise<void> {
  for await (const event of context.event.subscribe({ signal })) {
    if (event.type !== "session.execution.succeeded") continue;
    const sessionID = event.data?.sessionID;
    if (!sessionID) continue;
    try {
      const session = await context.session.get({ sessionID });
      if (session?.parentID) continue;
      if (!claimSnapPrompt(markerDir, sessionID)) continue;
      await context.session.synthetic({ sessionID, text: SNAP_PROMPT, description: "ahood snap prompt" });
    } catch {
      // A failed reminder must never get in the way of the session.
    }
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
      // Off, the hook does no work at all: it does not even listen.
      if (!snapHookEnabled(env)) return;
      const stop = new AbortController();
      void runSnapHook(context, markerDir, stop.signal).catch(() => {});
      return () => stop.abort();
    },
  };
}

export default createPlugin();
