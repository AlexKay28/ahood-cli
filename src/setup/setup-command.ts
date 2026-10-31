// `ahood setup [claude|codex|opencode]` and `ahood setup --remove <harness>`
// (ahood#980, epic ahood#968): wire ahood into the agent harnesses already on
// this machine. The harness modules (./harnesses/) only plan; this command
// shows the plan, asks, and applies it through ./file-changes.ts, which owns
// the backup / idempotency / dry-run rules for every harness.
import { existsSync } from "node:fs";
import { askLine, confirmYesNo, isInteractive } from "../confirm.js";
import { LEGACY_TOKEN_ENV, resolveToken, resolveTokenWithSource, TOKEN_ENV } from "../credentials.js";
import { login } from "../commands/login.js";
import { flagValue, unrecognizedArgs } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { SetupRefusedError } from "./errors.js";
import { actionOf, applyChanges, backupStamp, fileMode, formatChanges, writeBackup } from "./file-changes.js";
import { HARNESSES } from "./harnesses/index.js";
import { HARNESS_IDS, isHarnessId, type Harness, type HarnessId, type SetupPlan } from "./harnesses/types.js";
import { displayPath } from "./paths.js";
import { releaseBranchExists } from "./release-channel.js";
import { runner } from "./runner.js";

const USAGE =
  "Usage: ahood setup [claude|codex|opencode] [--yes] [--dry-run] [--store-token|--no-store-token] [--no-auto-update]\n" +
  "   or: ahood setup --remove <claude|codex|opencode> [--yes] [--dry-run]";

type Parsed = {
  targets: HarnessId[] | null;
  remove: boolean;
  yes: boolean;
  dryRun: boolean;
  /** true = --store-token, false = --no-store-token, null = ask (or keep what is there). */
  storeToken: boolean | null;
  /** --no-auto-update: do not ask, do not turn background plugin updates on (ahood#1018 step C). */
  noAutoUpdate: boolean;
};

function parseArgs(args: string[]): Parsed {
  const yes = args.includes("--yes") || args.includes("-y");
  const dryRun = args.includes("--dry-run");
  const store = args.includes("--store-token");
  const noStore = args.includes("--no-store-token");
  const noAutoUpdate = args.includes("--no-auto-update");
  if (store && noStore) throw new UsageError(`--store-token and --no-store-token contradict each other.\n${USAGE}`);
  const removeValue = flagValue(args, "--remove");
  if (removeValue !== undefined && (store || noStore)) throw new UsageError(`--remove always takes out a token setup stored.\n${USAGE}`);
  if (removeValue !== undefined && noAutoUpdate) throw new UsageError(`--remove always takes out the auto-update setup turned on.\n${USAGE}`);
  const positionals = unrecognizedArgs(args, ["--yes", "-y", "--dry-run", "--store-token", "--no-store-token", "--no-auto-update"], ["--remove"]);
  const unknownFlag = positionals.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${USAGE}`);
  if (positionals.length > 1) throw new UsageError(`One harness at a time (got: ${positionals.join(" ")}).\n${USAGE}`);
  if (removeValue !== undefined && positionals.length > 0) {
    throw new UsageError(`--remove takes the harness itself: ahood setup --remove ${removeValue}\n${USAGE}`);
  }
  const named = removeValue ?? positionals[0];
  if (named !== undefined && !isHarnessId(named)) {
    throw new UsageError(`Unknown harness "${named}" -- expected one of: ${HARNESS_IDS.join(", ")}.\n${USAGE}`);
  }
  const storeToken = store ? true : noStore ? false : null;
  return { targets: named === undefined ? null : [named as HarnessId], remove: removeValue !== undefined, yes, dryRun, storeToken, noAutoUpdate };
}

// ---- login and the token (ahood#990, decision B) ---------------------------
// The token is never printed or logged here: only file paths, env var names
// and modes are. tests/setup-token.test.ts asserts no output ever holds it.

/** No token anywhere: offer the normal `ahood login` device flow first. */
async function ensureLoggedIn(parsed: Parsed): Promise<void> {
  if (parsed.remove || parsed.dryRun || resolveTokenWithSource()) return;
  if (!isInteractive()) {
    console.log(
      `Not logged in to ahood. The ahood MCP server needs a token: run \`ahood login\` (or set ${TOKEN_ENV}), then re-run \`ahood setup\`.`,
    );
    return;
  }
  const answer = parsed.yes ? "y" : (await askLine("You are not logged in to ahood. Log in now (approve in your browser)? [Y/n] ")).toLowerCase();
  if (answer !== "" && answer !== "y" && answer !== "yes") {
    console.log(`Continuing without a token; run \`ahood login\` later, then \`ahood setup\` again.`);
    return;
  }
  try {
    await login();
  } catch (error) {
    console.error(`Login did not finish (${error instanceof Error ? error.message : String(error)}); continuing without a token.`);
  }
}

const loose = (mode: number) => (mode & 0o077) !== 0;
const octal = (mode: number) => `0${mode.toString(8)}`;

type TokenDecision = { token: string | null; mode?: number };

/**
 * Whether to store the token in this harness's config, and with what file
 * mode. Consent is explicit: --store-token, or a yes to the question; --yes
 * alone does not store a secret. With neither, a token setup stored earlier
 * is kept (refreshed to the current one) rather than silently taken out.
 * A file we create is 0600; an existing file readable by others is tightened
 * only on a separate yes, and the token is not stored in it otherwise.
 */
async function decideToken(harness: Harness, parsed: Parsed): Promise<TokenDecision> {
  const store = harness.tokenStore;
  if (!store) return { token: null };
  const file = store.file();
  if (store.userSet()) {
    console.log(`${harness.label}: ${displayPath(file)} already sets ${TOKEN_ENV} (not by ahood setup); leaving it as it is.`);
    return { token: null };
  }
  const already = store.stored();
  const token = resolveToken() ?? already;
  if (token === null) return { token: null };
  const canAsk = isInteractive() && !parsed.yes && !parsed.dryRun;
  let consent: boolean;
  if (parsed.storeToken !== null) consent = parsed.storeToken;
  else if (!canAsk) consent = already !== null;
  else {
    const answer = (
      await askLine(
        `\n${harness.label}: store your ahood token in ${displayPath(file)} (${store.what}) so ${harness.label} can reach the ahood MCP server ` +
          `without ${TOKEN_ENV} in its environment? ${already ? "[Y/n]" : "[y/N]"} `,
      )
    ).toLowerCase();
    consent = answer === "y" || answer === "yes" || (answer === "" && already !== null);
  }
  if (!consent) return { token: null };
  const mode = fileMode(file);
  if (mode === null) return { token, mode: 0o600 };
  if (!loose(mode)) return { token };
  const why = `${displayPath(file)} is readable by other users (mode ${octal(mode)})`;
  if (canAsk && (await confirmYesNo(`${why}. Make it user-only (chmod 600) so the token stays private? [y/N] `))) {
    return { token, mode: 0o600 };
  }
  console.error(`${harness.label}: warning: ${why}; not storing the token there. Run \`chmod 600 ${displayPath(file)}\`, then re-run with --store-token.`);
  return { token: null };
}

/**
 * Whether to turn on background plugin updates (ahood#1018 step C), asked
 * once: not when they are on already, never with --no-auto-update. The
 * default is yes, so --yes (and a preview: --dry-run, or no terminal) means yes.
 */
async function decideAutoUpdate(harness: Harness, parsed: Parsed): Promise<boolean> {
  const consent = harness.autoUpdateConsent;
  if (!consent || parsed.noAutoUpdate) return false;
  if (consent.enabled()) return true;
  if (parsed.yes || parsed.dryRun || !isInteractive()) return true;
  const answer = (await askLine(`\n${harness.label}: ${consent.question}`)).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Where the harness will look for the token once this run is done, when that is the user's job. */
function tokenNotes(harness: Harness, decision: TokenDecision, plan: SetupPlan): void {
  if (!harness.tokenStore || decision.token !== null || harness.tokenStore.userSet()) return;
  if (!process.env[TOKEN_ENV] && process.env[LEGACY_TOKEN_ENV]) {
    plan.notes.push(`${harness.label}'s ahood config now reads ${TOKEN_ENV}, not ${LEGACY_TOKEN_ENV}: rename it where you export it.`);
  }
  plan.notes.push(
    `${harness.label} reads the token from ${TOKEN_ENV} in the environment it starts in: add \`export ${TOKEN_ENV}=<your token>\` ` +
      `to your shell profile, or re-run \`ahood setup ${harness.id} --store-token\` to keep it in ${displayPath(harness.tokenStore.file())}.`,
  );
}

async function chooseTargets(yes: boolean): Promise<HarnessId[]> {
  const detected = HARNESS_IDS.filter((id) => HARNESSES[id].detect().installed);
  if (detected.length === 0) {
    const searched = HARNESS_IDS.map((id) => `\`${id}\` on PATH or ${displayPath(HARNESSES[id].detect().configDir)}`);
    console.log(`No supported harness found (looked for ${searched.join("; ")}).`);
    console.log("To set one up anyway, name it: ahood setup <claude|codex|opencode>");
    return [];
  }
  console.log(`Detected: ${detected.map((id) => `${HARNESSES[id].label} (${id})`).join(", ")}`);
  if (yes) return detected;
  if (!isInteractive()) {
    throw new UsageError(
      "ahood setup needs to know which harness to set up, and there is no terminal to ask on. " +
        `Run \`ahood setup <${detected.join("|")}>\`, or \`ahood setup --yes\` for every detected one.`,
    );
  }
  const answer = (await askLine(`Set up which? (${detected.join(", ")}, "all", or "none") [all] `)).toLowerCase();
  if (answer === "" || answer === "all") return detected;
  if (answer === "none") return [];
  const picked = answer.split(/[\s,]+/).filter(Boolean);
  const unknown = picked.filter((p) => !isHarnessId(p));
  if (unknown.length > 0) throw new UsageError(`Unknown harness: ${unknown.join(", ")} -- expected one of: ${HARNESS_IDS.join(", ")}.`);
  return [...new Set(picked)] as HarnessId[];
}

function hasWork(plan: SetupPlan): boolean {
  return plan.commands.length > 0 || plan.afterCommands.length > 0 || plan.files.some((f) => actionOf(f) !== "unchanged");
}

function commandLine(bin: string, args: string[]): string {
  return [bin.split("/").pop(), ...args].join(" ");
}

// With --yes (and not --dry-run) the preview is skipped: the applied summary
// that follows says the same thing in the past tense.
function printPlan(harness: Harness, plan: SetupPlan, remove: boolean, preview: boolean): void {
  console.log(`\n${harness.label} (${remove ? `ahood setup --remove ${harness.id}` : `ahood setup ${harness.id}`}):`);
  if (preview && plan.files.length > 0) {
    for (const line of formatChanges(applyChanges(plan.files, { dryRun: true, stamp: "<timestamp>" }), true)) console.log(line);
  }
  if (preview) for (const c of plan.commands) console.log(`  would run    ${commandLine(c.bin, c.args)} -- ${c.what}`);
  if (preview) for (const d of plan.afterCommands) console.log(`  then update  ${displayPath(d.path)} -- ${d.what}`);
  if (plan.manual.length > 0) {
    console.log(`  Type these in a ${harness.label} session:`);
    for (const m of plan.manual) console.log(`    ${m}`);
  }
  for (const n of plan.notes) console.log(`  note: ${n}`);
}

type Outcome = "done" | "nothing" | "dry-run" | "declined" | "needs-consent" | "refused" | "failed";

/** The harnesses that install the plugin from the `release` branch (ahood#1018 step B); opencode reads npm. */
const READS_RELEASE_BRANCH: readonly HarnessId[] = ["claude", "codex"];

async function runOne(harness: Harness, parsed: Parsed, stamp: string, releaseBranch: boolean | null): Promise<Outcome> {
  let plan: SetupPlan;
  try {
    if (parsed.remove) {
      plan = harness.planRemove();
    } else {
      const decision = await decideToken(harness, parsed);
      const autoUpdate = await decideAutoUpdate(harness, parsed);
      plan = harness.planSetup({ yes: parsed.yes, token: decision.token, releaseBranch, autoUpdate });
      if (decision.mode !== undefined) {
        for (const change of plan.files) if (change.path === harness.tokenStore?.file() && change.after !== null) change.mode = decision.mode;
      }
      tokenNotes(harness, decision, plan);
    }
  } catch (error) {
    if (!(error instanceof SetupRefusedError)) throw error;
    console.error(`\n${harness.label}: refused -- ${error.message}`);
    return "refused";
  }
  const work = hasWork(plan);
  printPlan(harness, plan, parsed.remove, parsed.dryRun || !parsed.yes || !work);
  if (!work) {
    if (plan.manual.length === 0) console.log(parsed.remove ? "  Nothing of ahood's to remove." : "  Already set up; nothing to change.");
    return "nothing";
  }
  if (parsed.dryRun) return "dry-run";
  if (!parsed.yes) {
    if (!isInteractive()) return "needs-consent";
    if (!(await confirmYesNo(`Apply these ${harness.label} changes? [y/N] `))) {
      console.log("  Skipped; nothing was changed.");
      return "declined";
    }
  }
  const applied = applyChanges(plan.files, { dryRun: false, stamp });
  for (const line of formatChanges(applied, false)) console.log(line);
  // A file a command is about to rewrite before a deferred change edits it
  // (claude's settings.json) is backed up now, as the user had it -- unless
  // setup itself just edited it, which already backed it up.
  for (const path of new Set(plan.afterCommands.map((d) => d.path))) {
    if (existsSync(path) && !applied.some((a) => a.path === path && a.action !== "unchanged")) {
      // A token setup stored there is redacted, as in every other backup (ahood#990).
      const secrets = path === harness.tokenStore?.file() ? [harness.tokenStore.stored()].filter((t): t is string => t !== null) : [];
      console.log(`  backed up    ${displayPath(path)} (backup: ${displayPath(writeBackup(path, stamp, secrets))})`);
    }
  }
  for (const c of plan.commands) {
    console.log(`  running      ${commandLine(c.bin, c.args)}`);
    const result = runner().run(c.bin, c.args, { inherit: true, timeoutMs: 180_000 });
    if (result.status !== 0) {
      console.error(`  failed (exit ${result.status ?? "signal"}): could not ${c.what}.`);
      return "failed";
    }
  }
  // Planned only now, on the files as the commands left them; the backup above
  // (or setup's own edit's) holds the user's version, so none is made of the
  // file as the command just wrote it.
  const deferred = plan.afterCommands
    .map((d) => d.plan())
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map((c) => ({ ...c, regenerable: c.before ?? undefined }));
  for (const line of formatChanges(applyChanges(deferred, { dryRun: false, stamp }), false)) console.log(line);
  return "done";
}

export async function setup(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  await ensureLoggedIn(parsed);
  const targets = parsed.targets ?? (await chooseTargets(parsed.yes));
  const stamp = backupStamp();
  const outcomes: Outcome[] = [];
  const releaseBranch = !parsed.remove && targets.some((id) => READS_RELEASE_BRANCH.includes(id)) ? await releaseBranchExists() : null;
  for (const id of targets) outcomes.push(await runOne(HARNESSES[id], parsed, stamp, releaseBranch));

  if (outcomes.includes("dry-run")) console.log("\nNothing was changed (--dry-run).");
  if (outcomes.some((o) => o === "refused" || o === "failed")) process.exitCode = 1;
  if (outcomes.includes("needs-consent")) {
    throw new UsageError(
      "ahood setup will not change another tool's config without consent, and there is no terminal to ask on. " +
        "Re-run with --yes to apply the changes above, or --dry-run to only see them.",
    );
  }
}
