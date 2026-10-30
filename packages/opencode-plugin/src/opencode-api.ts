// The slice of opencode's v2 plugin API this plugin uses, copied from
// @opencode/plugin@2.1.2 (dist/promise/{plugin,command,mcp,session,event}.d.ts)
// and @opencode/schema@2.1.2 (dist/mcp.d.ts) rather than depended on: that
// package pulls in effect, the opencode client and peer UI packages, and the
// host hands the plugin its context at runtime anyway. Only what server.ts
// calls is declared; widen it from those files, not from memory.

export interface CommandInvocation {
  readonly sessionID: string;
  /** What the user typed after the command name is `prompt.text`; the rest is passed through to session.prompt. */
  readonly prompt: { readonly text: string } & Record<string, unknown>;
  readonly delivery: "steer" | "queue";
}

export interface CommandDefinition {
  readonly name: string;
  readonly description?: string;
  readonly execute: (input: CommandInvocation) => Promise<void>;
}

export interface CommandEditor {
  add(definition: CommandDefinition): void;
}

/** Mcp.RemoteConfig, the shape of an `mcp.servers.<name>` entry. */
export interface RemoteMcpConfig {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpEditor {
  get(name: string): unknown;
  set(name: string, config: RemoteMcpConfig): void;
}

export interface Registration {
  readonly dispose: () => Promise<void>;
}

/** The members of an opencode event this plugin reads (V2Event in @opencode/client). */
export interface OpencodeEvent {
  readonly type: string;
  readonly data?: { readonly sessionID?: string };
}

export interface PluginContext {
  readonly command: { transform(callback: (editor: CommandEditor) => void): Promise<Registration> };
  readonly mcp: { transform(callback: (editor: McpEditor) => void): Promise<Registration> };
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OpencodeEvent> };
  readonly session: {
    prompt(input: { sessionID: string; text: string; delivery?: "steer" | "queue" } & Record<string, unknown>): Promise<unknown>;
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<unknown>;
    get(input: { sessionID: string }): Promise<{ parentID?: string } | undefined>;
  };
}

export type Cleanup = () => Promise<void> | void;

export interface Plugin {
  readonly id: string;
  readonly setup: (context: PluginContext) => Promise<Cleanup | void>;
}
