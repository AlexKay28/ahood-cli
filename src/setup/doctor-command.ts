// `ahood doctor [--offline] [--json]` (ahood#980): per harness -- detected?,
// ahood's config in place?, plus the checks every harness shares: the MCP
// server reachable, logged in, this CLI vs the latest on npm. Exits 1 when a
// harness that IS set up is broken (partial or unreadable config, or the MCP
// server it points at is unreachable); warnings alone exit 0.
import { LEGACY_TOKEN_ENV, resolveTokenWithSource, TOKEN_ENV, type TokenSource } from "../credentials.js";
import { unrecognizedArgs } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { CLI_NAME, CLI_VERSION } from "../version.js";
import { checkAuth } from "../commands/whoami.js";
import { HARNESSES } from "./harnesses/index.js";
import { HARNESS_IDS, type ConfigState, type Feature, type HarnessId } from "./harnesses/types.js";
import { displayPath } from "./paths.js";
import { AHOOD_MCP_URL } from "./templates/ahood-commands.js";

const USAGE = "Usage: ahood doctor [--offline] [--json]";
const PROBE_TIMEOUT_MS = 5_000;
export const NPM_LATEST_URL = "https://registry.npmjs.org/@ahood%2fcli/latest";
/** The npm registry document for `pkg` at `version` (404 when that version was never published). */
export const npmVersionUrl = (pkg: string, version: string) => `https://registry.npmjs.org/${pkg.replace("/", "%2f")}/${version}`;

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type Check = { name: string; status: CheckStatus; detail: string };
export type HarnessReport = {
  id: HarnessId;
  label: string;
  detected: boolean;
  binary: string | null;
  config: ConfigState;
  checks: Check[];
};

async function probe(url: string): Promise<{ status?: number; error?: string }> {
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => {});
    return { status: response.status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function mcpCheck(offline: boolean): Promise<Check> {
  const name = "MCP server reachable";
  if (offline) return { name, status: "skip", detail: "--offline" };
  const { status, error } = await probe(AHOOD_MCP_URL);
  // Any answer below 500 means the server is up: a bare GET on a streamable-
  // HTTP endpoint is normally refused with 405.
  if (status !== undefined && status < 500) return { name, status: "ok", detail: `${AHOOD_MCP_URL} answered HTTP ${status}` };
  return { name, status: "fail", detail: `${AHOOD_MCP_URL} ${status !== undefined ? `answered HTTP ${status}` : `unreachable (${error})`}` };
}

const SOURCE_LABEL: Record<TokenSource, string> = {
  [TOKEN_ENV]: `$${TOKEN_ENV}`,
  [LEGACY_TOKEN_ENV]: `$${LEGACY_TOKEN_ENV} (deprecated)`,
  credentials: "stored login (`ahood login`)",
};

/** Which token the CLI uses -- by name only, never the value (ahood#990). */
function tokenSourceCheck(): Check {
  const name = "token source";
  const resolved = resolveTokenWithSource();
  if (!resolved) return { name, status: "warn", detail: `none -- run \`ahood login\` (or set ${TOKEN_ENV})` };
  if (resolved.source === LEGACY_TOKEN_ENV) {
    return {
      name,
      status: "warn",
      detail: `only $${LEGACY_TOKEN_ENV} is set -- it is deprecated and works for this release cycle only; rename it to ${TOKEN_ENV}`,
    };
  }
  return { name, status: "ok", detail: SOURCE_LABEL[resolved.source] };
}

async function loginCheck(offline: boolean): Promise<Check> {
  const name = "logged in";
  if (!resolveTokenWithSource()) return { name, status: "warn", detail: `no token -- run \`ahood login\` (or set ${TOKEN_ENV})` };
  if (offline) return { name, status: "ok", detail: "token present (not verified: --offline)" };
  const auth = await checkAuth();
  if (auth.authenticated === true) {
    const who = auth.profile?.username ? ` as ${auth.profile.username}` : "";
    return { name, status: "ok", detail: `authenticated${who}${auth.mode === "token" ? " (personal API token)" : ""}` };
  }
  if (auth.authenticated === false) return { name, status: "warn", detail: "token rejected -- run `ahood login` again" };
  return { name, status: "warn", detail: `could not verify the token (${auth.error})` };
}

function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

async function versionCheck(offline: boolean): Promise<Check> {
  const name = "CLI version";
  if (offline) return { name, status: "skip", detail: `${CLI_NAME} ${CLI_VERSION} (latest not checked: --offline)` };
  try {
    const response = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { name, status: "warn", detail: `${CLI_VERSION}; npm answered HTTP ${response.status}` };
    const latest = ((await response.json()) as { version?: unknown }).version;
    if (typeof latest !== "string") return { name, status: "warn", detail: `${CLI_VERSION}; npm gave no version` };
    if (newer(latest, CLI_VERSION)) return { name, status: "warn", detail: `${CLI_VERSION}, latest is ${latest} -- npm i -g ${CLI_NAME}` };
    return { name, status: "ok", detail: `${CLI_VERSION} (latest ${latest})` };
  } catch (error) {
    return { name, status: "warn", detail: `${CLI_VERSION}; could not reach npm (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Whether npm has the package a harness installs by itself (Harness.npmPackage)
 * at this CLI's version. opencode skips a plugin it cannot install without an
 * error, so without this check a missing package would only show as missing
 * /ahood commands.
 */
async function npmPackageCheck(pkg: string, offline: boolean): Promise<Check> {
  const name = "plugin on npm";
  const wanted = `${pkg}@${CLI_VERSION}`;
  if (offline) return { name, status: "skip", detail: `${wanted} not checked (--offline)` };
  try {
    const response = await fetch(npmVersionUrl(pkg, CLI_VERSION), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.ok) return { name, status: "ok", detail: `${wanted} is published` };
    if (response.status === 404) {
      return {
        name,
        status: "warn",
        detail:
          `${wanted} is NOT on npm (not published yet), so the harness cannot install it and skips it silently: ` +
          "no /ahood commands or snap prompt there until it is published. The MCP entry setup wrote still works",
      };
    }
    return { name, status: "warn", detail: `could not check ${wanted}: npm answered HTTP ${response.status}` };
  } catch (error) {
    return { name, status: "warn", detail: `could not check ${wanted}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const CONFIG_STATUS: Record<ConfigState["state"], CheckStatus> = { ok: "ok", absent: "skip", stale: "warn", partial: "fail", broken: "fail" };

/**
 * A feature's own `absent` is only a skip (not a failure) when it is marked
 * `optional` (the Claude Code snap hook: off by default). Any other feature
 * shown here at all means the harness is set up at least partially, so a
 * missing piece of it is a real gap, not nothing-to-report.
 */
function featureStatus(feature: Feature): CheckStatus {
  if (feature.state === "absent") return feature.optional ? "skip" : "fail";
  return CONFIG_STATUS[feature.state];
}
const CONFIG_HINT: Partial<Record<ConfigState["state"], string>> = {
  stale: "re-run `ahood setup <h>` to refresh",
  partial: "re-run `ahood setup <h>` to repair",
  broken: "fix the file, then re-run `ahood setup <h>`",
  absent: "not set up -- `ahood setup <h>`",
};

function harnessReport(id: HarnessId, mcp: Check, packageCheck: Check | undefined): HarnessReport {
  const harness = HARNESSES[id];
  const detection = harness.detect();
  const config = harness.inspect();
  const hint = CONFIG_HINT[config.state]?.replace("<h>", id);
  const checks: Check[] = [
    {
      name: "detected",
      status: detection.installed ? "ok" : "skip",
      detail: detection.installed
        ? [detection.binary ? `${detection.binary}` : `${id} not on PATH`, detection.configDirExists ? displayPath(detection.configDir) : null].filter(Boolean).join(", ")
        : `no \`${id}\` on PATH and no ${displayPath(detection.configDir)}`,
    },
    { name: "ahood config", status: CONFIG_STATUS[config.state], detail: [config.state, ...config.details, hint].filter(Boolean).join("; ") },
  ];
  if (config.state !== "absent") {
    // Per-feature breakdown (an MCP entry, a skill, command files, an opt-in
    // hook, ...): what `ahood setup <id>` can write, one row per thing, so
    // `doctor` says exactly which harness features are installed rather than
    // just an overall state.
    for (const feature of config.features) checks.push({ name: feature.name, status: featureStatus(feature), detail: feature.detail });
    if (packageCheck) checks.push(packageCheck);
    checks.push(mcp);
    checks.push(mcpTokenCheck(id, config));
  }
  return { id, label: harness.label, detected: detection.installed, binary: detection.binary, config, checks };
}

/** Where this harness's MCP entry gets its token: stored by setup, $AHOOD_TOKEN, or nowhere. */
function mcpTokenCheck(id: HarnessId, config: ConfigState): Check {
  const name = "MCP token";
  const store = HARNESSES[id].tokenStore;
  if (config.tokenStored && store) return { name, status: "ok", detail: `stored by ahood setup in ${displayPath(store.file())}` };
  if (store?.userSet()) return { name, status: "ok", detail: `${TOKEN_ENV} set in ${displayPath(store.file())}` };
  if (process.env[TOKEN_ENV]) return { name, status: "ok", detail: `${TOKEN_ENV} is set in this shell` };
  if (process.env[LEGACY_TOKEN_ENV]) {
    return {
      name,
      status: "warn",
      detail: `only ${LEGACY_TOKEN_ENV} is set; this harness's ahood config reads ${TOKEN_ENV} -- rename it (or \`ahood setup ${id} --store-token\`)`,
    };
  }
  return {
    name,
    status: "warn",
    detail:
      `${TOKEN_ENV} is not set in this shell and no token is stored; the MCP server refuses requests without one. ` +
      `Run \`ahood setup ${id} --store-token\`, or export ${TOKEN_ENV} where the harness runs`,
  };
}

const MARK: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "--  " };

export async function doctor(args: string[]): Promise<void> {
  const leftovers = unrecognizedArgs(args, ["--offline", "--json"], []);
  if (leftovers.length > 0) throw new UsageError(`Unknown argument: ${leftovers[0]}\n${USAGE}`);
  const offline = args.includes("--offline");
  const json = args.includes("--json");

  const source = tokenSourceCheck();
  const [mcp, login, version] = await Promise.all([mcpCheck(offline), loginCheck(offline), versionCheck(offline)]);
  const packageChecks = new Map(
    await Promise.all(
      HARNESS_IDS.filter((id) => HARNESSES[id].npmPackage).map(async (id) => [id, await npmPackageCheck(HARNESSES[id].npmPackage!, offline)] as const),
    ),
  );
  const harnesses = HARNESS_IDS.map((id) => harnessReport(id, mcp, packageChecks.get(id)));
  const broken = harnesses.filter((h) => h.config.state !== "absent" && h.checks.some((c) => c.status === "fail"));

  if (json) {
    console.log(JSON.stringify({ ok: broken.length === 0, cli: [source, login, version], harnesses }));
  } else {
    console.log("ahood doctor");
    for (const c of [version, source, login, mcp]) console.log(`  [${MARK[c.status]}] ${c.name}: ${c.detail}`);
    for (const h of harnesses) {
      console.log(`\n${h.label} (${h.id})`);
      for (const c of h.checks) console.log(`  [${MARK[c.status]}] ${c.name}: ${c.detail}`);
    }
    if (harnesses.every((h) => h.config.state === "absent")) console.log("\nNo harness is set up yet. Run `ahood setup` to pick one.");
    if (broken.length > 0) console.log(`\nBroken: ${broken.map((h) => h.id).join(", ")}.`);
  }
  if (broken.length > 0) process.exitCode = 1;
}
