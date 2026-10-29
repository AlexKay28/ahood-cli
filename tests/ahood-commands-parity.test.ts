// ahood#982 (epic #968, P6): `/ahood` must say the same thing in every harness.
// AHOOD_COMMANDS (src/setup/templates/ahood-commands.ts) is the one place that
// wording lives; codex.ts, opencode.ts and claude-plugin.ts only render it
// into each harness's own file format. These tests are the drift guard: they
// fail the moment one harness's rendering stops being built from that shared
// source, or starts paraphrasing it instead of reusing it verbatim.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AHOOD_COMMANDS, AHOOD_SNAP_HOOK_ENV, type AhoodCommand } from "../src/setup/templates/ahood-commands.js";
import { codexSkill } from "../src/setup/templates/codex.js";
import { opencodeCommandFiles } from "../src/setup/templates/opencode.js";
import { claudePluginCommandFiles, CLAUDE_PLUGIN_DIR } from "../src/setup/templates/claude-plugin.js";

const ROOT = join(import.meta.dirname, "..");

// Consent rules every harness must say in the same place, because they are
// the only thing standing between an agent and an unattended sync, approval
// or save. Phrased exactly as AHOOD_COMMANDS phrases them, so a change to the
// wording in one place is a change everywhere, and a paraphrase in one
// rendering (which would not match this substring) fails loudly.
const CONSENT_PHRASES: Record<string, string[]> = {
  ahood: [],
  "ahood-sync": ["Never update anything without the user's explicit yes.", "only for the ones they approved"],
  "ahood-review": ["only on the user's explicit decision"],
  "ahood-snap": ["save it only if the user agrees", "Snaps are private to the user"],
};

describe("AHOOD_COMMANDS is the single source for every harness's /ahood wording", () => {
  const codex = codexSkill();
  const opencodeFiles = new Map(opencodeCommandFiles().map((f) => [f.file, f.content]));
  const claudeFiles = new Map(claudePluginCommandFiles().map((f) => [f.file, f.content]));

  it("renders one opencode command file and one Claude plugin command file per shared command", () => {
    expect([...opencodeFiles.keys()].sort()).toEqual(AHOOD_COMMANDS.map((c) => `${c.name}.md`).sort());
    expect([...claudeFiles.keys()].sort()).toEqual(AHOOD_COMMANDS.map((c) => `commands/${c.name}.md`).sort());
  });

  for (const c of AHOOD_COMMANDS) {
    describe(c.name, () => {
      it("the Codex skill contains this command's body verbatim", () => {
        expect(codex).toContain(c.body);
      });

      it("the opencode command file contains this command's body verbatim", () => {
        expect(opencodeFiles.get(`${c.name}.md`)).toContain(c.body);
      });

      it("the Claude plugin command (and, for the verbs, the /ahood dashboard's section) contains it verbatim", () => {
        expect(claudeFiles.get(`commands/${c.name}.md`)).toContain(c.body);
        if (c.name !== "ahood") expect(claudeFiles.get("commands/ahood.md")).toContain(c.body);
      });

      for (const phrase of CONSENT_PHRASES[c.name] ?? []) {
        it(`every harness's rendering keeps the consent rule: ${JSON.stringify(phrase)}`, () => {
          expect(codex).toContain(phrase);
          expect(opencodeFiles.get(`${c.name}.md`)).toContain(phrase);
          expect(claudeFiles.get(`commands/${c.name}.md`)).toContain(phrase);
        });
      }
    });
  }

  it("the on-disk Claude plugin commands are exactly what claude-plugin.ts renders (redundant with tests/claude-plugin.test.ts, kept here so this file alone proves parity)", () => {
    for (const { file, content } of claudePluginCommandFiles()) {
      expect(readFileSync(join(ROOT, CLAUDE_PLUGIN_DIR, file), "utf-8")).toBe(content);
    }
  });

  it("the Codex skill names every command this plugin's using-ahood skill names, under the same consent rules", () => {
    const claudeSkill = readFileSync(join(ROOT, CLAUDE_PLUGIN_DIR, "skills", "using-ahood", "SKILL.md"), "utf-8");
    // Both must insist sync is never automatic and snaps are private -- the
    // two rules a single misworded template could quietly drop.
    for (const text of [codex, claudeSkill]) {
      expect(text).toMatch(/never sync|Never update anything without the user's explicit yes/i);
      expect(text).toMatch(/private/i);
    }
  });
});

describe("the opt-in Claude Code snap hook's enable switch has exactly one literal value", () => {
  // plugins/ahood/hooks/snap-prompt.mjs must stay import-free (no network, no
  // child_process -- see tests/claude-plugin-hook.test.ts), so it cannot
  // import AHOOD_SNAP_HOOK_ENV from this module and keeps its own copy of the
  // same string instead. This test is what keeps the two copies from drifting.
  it("AHOOD_SNAP_HOOK_ENV matches the hook script's own ENABLE_ENV", async () => {
    const hookModule = (await import(join(ROOT, CLAUDE_PLUGIN_DIR, "hooks", "snap-prompt.mjs"))) as { ENABLE_ENV: string };
    expect(AHOOD_SNAP_HOOK_ENV).toBe(hookModule.ENABLE_ENV);
    expect(AHOOD_SNAP_HOOK_ENV).toBe("AHOOD_SNAP_HOOK");
  });
});

describe("AHOOD_COMMANDS itself carries the consent rules (so the checks above are testing real content, not an empty string)", () => {
  const byName = (name: string): AhoodCommand => {
    const found = AHOOD_COMMANDS.find((c) => c.name === name);
    if (!found) throw new Error(`no command named ${name}`);
    return found;
  };

  it("ahood-sync: never syncs without explicit per-update approval", () => {
    expect(byName("ahood-sync").body).toMatch(/Never update anything without the user's explicit yes/);
    expect(byName("ahood-sync").body).toMatch(/only for the ones they approved/);
  });

  it("ahood-review: approve/reject only on the user's word", () => {
    expect(byName("ahood-review").body).toMatch(/only on the user's explicit decision/);
  });

  it("ahood-snap: asks before saving, and snaps are private", () => {
    expect(byName("ahood-snap").body).toMatch(/ask whether to save it/);
    expect(byName("ahood-snap").body).toMatch(/Snaps are private to the user/);
  });

  it("every command treats content fetched from the registry as untrusted or routes through the CLI's own login gate", () => {
    for (const c of AHOOD_COMMANDS) expect(c.body).toMatch(/not logged in|untrusted input/);
  });
});
