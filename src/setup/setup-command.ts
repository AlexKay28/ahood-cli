// `ahood setup [claude|codex|opencode]` and `ahood setup --remove <harness>`
// (ahood#980, epic ahood#968): wire ahood into the agent harnesses already on
// this machine. The harness modules (./harnesses/) only plan; this command
// shows the plan, asks, and applies it through ./file-changes.ts, which owns
// the backup / idempotency / dry-run rules for every harness.
import { askLine, confirmYesNo, isInteractive } from "../confirm.js";
import { flagValue, unrecognizedArgs } from "../flags.js";
import { UsageError } from "../usage-error.js";
import { SetupRefusedError } from "./errors.js";
import { actionOf, applyChanges, backupStamp, formatChanges } from "./file-changes.js";
import { HARNESSES } from "./harnesses/index.js";
import { HARNESS_IDS, isHarnessId, type Harness, type HarnessId, type SetupPlan } from "./harnesses/types.js";
import { displayPath } from "./paths.js";
import { runner } from "./runner.js";

const USAGE =
  "Usage: ahood setup [claude|codex|opencode] [--yes] [--dry-run]\n" +
  "   or: ahood setup --remove <claude|codex|opencode> [--yes] [--dry-run]";

type Parsed = { targets: HarnessId[] | null; remove: boolean; yes: boolean; dryRun: boolean };

function parseArgs(args: string[]): Parsed {
  const yes = args.includes("--yes") || args.includes("-y");
  const dryRun = args.includes("--dry-run");
  const removeValue = flagValue(args, "--remove");
  const positionals = unrecognizedArgs(args, ["--yes", "-y", "--dry-run"], ["--remove"]);
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
  return { targets: named === undefined ? null : [named as HarnessId], remove: removeValue !== undefined, yes, dryRun };
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
  return plan.commands.length > 0 || plan.files.some((f) => actionOf(f) !== "unchanged");
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
  if (plan.manual.length > 0) {
    console.log(`  Type these in a ${harness.label} session:`);
    for (const m of plan.manual) console.log(`    ${m}`);
  }
  for (const n of plan.notes) console.log(`  note: ${n}`);
}

type Outcome = "done" | "nothing" | "dry-run" | "declined" | "needs-consent" | "refused" | "failed";

async function runOne(harness: Harness, parsed: Parsed, stamp: string): Promise<Outcome> {
  let plan: SetupPlan;
  try {
    plan = parsed.remove ? harness.planRemove() : harness.planSetup({ yes: parsed.yes });
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
  for (const c of plan.commands) {
    console.log(`  running      ${commandLine(c.bin, c.args)}`);
    const result = runner().run(c.bin, c.args, { inherit: true, timeoutMs: 180_000 });
    if (result.status !== 0) {
      console.error(`  failed (exit ${result.status ?? "signal"}): could not ${c.what}.`);
      return "failed";
    }
  }
  return "done";
}

export async function setup(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const targets = parsed.targets ?? (await chooseTargets(parsed.yes));
  const stamp = backupStamp();
  const outcomes: Outcome[] = [];
  for (const id of targets) outcomes.push(await runOne(HARNESSES[id], parsed, stamp));

  if (outcomes.includes("dry-run")) console.log("\nNothing was changed (--dry-run).");
  if (outcomes.some((o) => o === "refused" || o === "failed")) process.exitCode = 1;
  if (outcomes.includes("needs-consent")) {
    throw new UsageError(
      "ahood setup will not change another tool's config without consent, and there is no terminal to ask on. " +
        "Re-run with --yes to apply the changes above, or --dry-run to only see them.",
    );
  }
}
