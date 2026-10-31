// opencode plugin (ahood#1009): packages/opencode-plugin, published as
// @ahood/opencode-plugin. This module renders the package's generated files
// -- package.json at the CLI's version, and src/generated.ts holding the
// /ahood command prompts (templates/opencode.ts, from AHOOD_COMMANDS), the MCP
// entry and the snap prompt (ahood-commands.ts) -- so the plugin says exactly
// what the other shells say. `npm run sync-plugin` writes them and
// tests/opencode-plugin.test.ts fails when they drift. The plugin's code
// (packages/opencode-plugin/src/server.ts) is hand-written; it only reads them.
//
// What an opencode v2 plugin can do, verified against opencode v2.1.2 (the
// @opencode/cli binary) and its authoring package @opencode/plugin@2.1.2
// (dist/promise/{plugin,command,mcp,session,event}.d.ts), 2026-10-29:
//   - Config: plugins are listed under `plugins` (plural) in opencode.json(c),
//     as an npm package name, a git specifier, a local path, or
//     `{ package, options }` (@opencode/schema config/plugin.d.ts); opencode
//     installs a missing npm package itself on load. A package's entry is its
//     `<name>/server` export, else `<name>` (@opencode/plugin dist/host.js),
//     whose default export is `{ id, setup(context) }`.
//   - Commands: context.command.transform(e => e.add({ name, description,
//     execute })) -- the same call opencode's own config-file commands go
//     through; `execute` sends the prompt with context.session.prompt.
//   - MCP servers: context.mcp.transform(e => e.set(name, config)), the same
//     remote config shape as `mcp.servers.<name>`. A same-named entry in the
//     user's opencode.json is already in the editor when ours runs, so the
//     plugin leaves it alone (that is how `--store-token`'s entry wins).
//     `{env:NAME}` is a config-file substitution only; the plugin reads the
//     token from its own environment, which is the same server process.
//   - Snap hook: context.event.subscribe() sees `session.execution.succeeded`
//     when a turn ends, and context.session.synthetic({ sessionID, text })
//     queues a message that resumes the session -- what opencode's subagent
//     completion notice does -- the counterpart of a Claude Code Stop hook's
//     {"decision":"block","reason"}.
// All three were exercised end to end with the real opencode v2.1.2 server
// (a local-path plugin, a mock model provider): the command reached the model
// with its arguments, the MCP server connected, and the snap prompt resumed
// the session exactly once.
import { CLI_VERSION } from "../../version.js";
import { AHOOD_COMMANDS, AHOOD_MCP_TOKEN_ENV, AHOOD_MCP_URL, AHOOD_SNAP_HOOK_ENV, AHOOD_SNAP_PROMPT } from "./ahood-commands.js";
import { opencodeCommandTemplate } from "./opencode.js";

export const OPENCODE_PLUGIN_DIR = "packages/opencode-plugin";
export const OPENCODE_PLUGIN_PACKAGE = "@ahood/opencode-plugin";
/** The plugin's `id` (opencode refuses two plugins with one id). */
export const OPENCODE_PLUGIN_ID = "ahood";
export const OPENCODE_MCP_SERVER_NAME = "ahood";

const REPO_URL = "https://github.com/AlexKay28/ahood-cli";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function packageJson(): string {
  return json({
    name: OPENCODE_PLUGIN_PACKAGE,
    version: CLI_VERSION,
    description:
      "ahood in opencode: the registry's hosted MCP server, the /ahood hub and its commands (find, try, install, " +
      "prompt, loop, project, star, publish, stats, sync, review, snap), and an opt-in snap prompt.",
    license: "MIT",
    homepage: "https://www.ahood.dev/docs#mcp",
    repository: { type: "git", url: `git+${REPO_URL}.git`, directory: OPENCODE_PLUGIN_DIR },
    keywords: ["opencode", "opencode-plugin", "ahood", "mcp", "skills", "snaps"],
    type: "module",
    main: "./dist/server.js",
    exports: { ".": "./dist/server.js", "./server": "./dist/server.js" },
    files: ["dist"],
    scripts: { build: "tsc -p tsconfig.json", prepublishOnly: "npm run build" },
  });
}

const GENERATED_NOTE =
  "// Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one.";

function generatedModule(): string {
  const commands = AHOOD_COMMANDS.map((c) => ({ name: c.name, description: c.description, template: opencodeCommandTemplate(c) }));
  const constant = (name: string, value: unknown) => `export const ${name} = ${JSON.stringify(value)};`;
  return [
    GENERATED_NOTE,
    "",
    constant("PLUGIN_ID", OPENCODE_PLUGIN_ID),
    constant("MCP_SERVER_NAME", OPENCODE_MCP_SERVER_NAME),
    constant("MCP_URL", AHOOD_MCP_URL),
    constant("TOKEN_ENV", AHOOD_MCP_TOKEN_ENV),
    constant("SNAP_HOOK_ENV", AHOOD_SNAP_HOOK_ENV),
    constant("SNAP_PROMPT", AHOOD_SNAP_PROMPT),
    "",
    "/** The /ahood commands; `template` is the prompt, with $ARGUMENTS standing for what the user typed after the name. */",
    `export const COMMANDS: ReadonlyArray<{ name: string; description: string; template: string }> = ${JSON.stringify(commands, null, 2)};`,
    "",
  ].join("\n");
}

/**
 * The opencode plugin files this module owns, as paths relative to the repo
 * root. The package's code, tsconfig and README are hand-written.
 */
export function opencodePluginFiles(): Array<{ file: string; content: string }> {
  return [
    { file: `${OPENCODE_PLUGIN_DIR}/package.json`, content: packageJson() },
    { file: `${OPENCODE_PLUGIN_DIR}/src/generated.ts`, content: generatedModule() },
  ];
}
