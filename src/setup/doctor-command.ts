// `ahood doctor [--offline] [--json]` (ahood#980): per harness -- detected?,
// ahood's config in place?, plus the checks every harness shares: the MCP
// server reachable, logged in, this CLI vs the latest on npm. Exits 1 when a
// harness that IS set up is broken (partial or unreadable config, or the MCP
// server it points at is unreachable); warnings alone exit 0.
import { resolveToken } from "../credentials.js";
import { unrecognizedArgs } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { CLI_NAME, CLI_VERSION } from "../version.js";
import { checkAuth } from "../commands/whoami.js";
import { HARNESSES } from "./harnesses/index.js";
import { HARNESS_IDS, type ConfigState, type HarnessId } from "./harnesses/types.js";
import { displayPath } from "./paths.js";
import { AHOOD_MCP_TOKEN_ENV, AHOOD_MCP_URL } from "./templates/ahood-commands.js";

const USAGE = "Usage: ahood doctor [--offline] [--json]";
const PROBE_TIMEOUT_MS = 5_000;
export const NPM_LATEST_URL = "https://registry.npmjs.org/@ahood%2fcli/latest";

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

async function loginCheck(offline: boolean): Promise<Check> {
  const name = "logged in";
  if (!resolveToken()) return { name, status: "warn", detail: "no token -- run `ahood login` (or set AHOOD_TOKEN)" };
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

const CONFIG_STATUS: Record<ConfigState["state"], CheckStatus> = { ok: "ok", absent: "skip", stale: "warn", partial: "fail", broken: "fail" };
const CONFIG_HINT: Partial<Record<ConfigState["state"], string>> = {
  stale: "re-run `ahood setup <h>` to refresh",
  partial: "re-run `ahood setup <h>` to repair",
  broken: "fix the file, then re-run `ahood setup <h>`",
  absent: "not set up -- `ahood setup <h>`",
};

function harnessReport(id: HarnessId, mcp: Check): HarnessReport {
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
    checks.push(mcp);
    checks.push(
      process.env[AHOOD_MCP_TOKEN_ENV]
        ? { name: "MCP token", status: "ok", detail: `${AHOOD_MCP_TOKEN_ENV} is set in this shell` }
        : {
            name: "MCP token",
            status: "warn",
            detail:
              `${AHOOD_MCP_TOKEN_ENV} is not set in this shell; the MCP server refuses requests without it. ` +
              "Mint one at https://www.ahood.dev/settings/tokens and export it where the harness runs",
          },
    );
  }
  return { id, label: harness.label, detected: detection.installed, binary: detection.binary, config, checks };
}

const MARK: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "--  " };

export async function doctor(args: string[]): Promise<void> {
  const leftovers = unrecognizedArgs(args, ["--offline", "--json"], []);
  if (leftovers.length > 0) throw new UsageError(`Unknown argument: ${leftovers[0]}\n${USAGE}`);
  const offline = args.includes("--offline");
  const json = args.includes("--json");

  const [mcp, login, version] = await Promise.all([mcpCheck(offline), loginCheck(offline), versionCheck(offline)]);
  const harnesses = HARNESS_IDS.map((id) => harnessReport(id, mcp));
  const broken = harnesses.filter((h) => h.config.state !== "absent" && h.checks.some((c) => c.status === "fail"));

  if (json) {
    console.log(JSON.stringify({ ok: broken.length === 0, cli: [login, version], harnesses }));
  } else {
    console.log("ahood doctor");
    for (const c of [version, login, mcp]) console.log(`  [${MARK[c.status]}] ${c.name}: ${c.detail}`);
    for (const h of harnesses) {
      console.log(`\n${h.label} (${h.id})`);
      for (const c of h.checks) console.log(`  [${MARK[c.status]}] ${c.name}: ${c.detail}`);
    }
    if (harnesses.every((h) => h.config.state === "absent")) console.log("\nNo harness is set up yet. Run `ahood setup` to pick one.");
    if (broken.length > 0) console.log(`\nBroken: ${broken.map((h) => h.id).join(", ")}.`);
  }
  if (broken.length > 0) process.exitCode = 1;
}
