import { describe, expect, it } from "vitest";
import {
  formatHelp,
  formatSkillHelp,
  formatGroupHelp,
  findCommandHelp,
  TOP_LEVEL_COMMANDS_HELP,
  SKILL_COMMANDS_HELP,
  GROUP_COMMANDS_HELP,
  usageWithAliases,
} from "../src/help.js";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Wrapped output splits a row's usage + summary across multiple lines (see
// formatCommandTable in help.ts) -- this collapses everything from a row's
// usage line up to (but not including) the next line that starts a new
// usage entry back into one whitespace-normalized string, so tests can
// assert content regardless of exactly how it wrapped.
function rowText(help: string, usagePrefix: string): string {
  const lines = help.split("\n");
  const startIndex = lines.findIndex((l) => l.trim().startsWith(usagePrefix.trim()));
  if (startIndex === -1) return "";
  const rest = lines.slice(startIndex + 1);
  const nextRowOffset = rest.findIndex((l) => /^  \S/.test(l));
  const block = nextRowOffset === -1 ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + 1 + nextRowOffset);
  return normalizeWhitespace(block.join(" "));
}

describe("formatHelp", () => {
  it("includes every top-level command's usage line and a quick-start section", () => {
    const help = formatHelp();
    for (const entry of TOP_LEVEL_COMMANDS_HELP) {
      expect(help).toContain(usageWithAliases(entry));
    }
    expect(help).toContain("Quick start:");
    expect(help).toContain("ahood login");
    expect(help).toContain("ahood skill search");
    expect(help).toContain("ahood skill add");
  });

  it("does not list skill verbs individually, only the 'ahood skill <command>' group line", () => {
    const help = formatHelp();
    const commandsSection = help.slice(help.indexOf("Commands:"));
    expect(commandsSection).toContain("ahood skill <command>");
    for (const entry of SKILL_COMMANDS_HELP) {
      expect(commandsSection).not.toContain(entry.usage);
    }
  });

  it("points at `ahood skill --help` for the full skill command list", () => {
    const help = formatHelp();
    expect(help).toContain("ahood skill --help");
  });

  it("every top-level command's summary is a genuinely single sentence", () => {
    for (const { usage, summary } of TOP_LEVEL_COMMANDS_HELP) {
      expect(summary, `${usage} summary should not embed a second sentence`).not.toContain(". ");
      expect(summary, `${usage} summary should end with exactly one period`).toMatch(/[^.]\.$/);
    }
  });
});

describe("formatSkillHelp", () => {
  it("includes every skill command's usage line (aliases folded in)", () => {
    const help = formatSkillHelp();
    for (const entry of SKILL_COMMANDS_HELP) {
      expect(help).toContain(usageWithAliases(entry));
    }
  });

  it("surfaces the 'show' alias next to 'view'", () => {
    const help = formatSkillHelp();
    expect(help).toMatch(/ahood skill view\|show\b/);
  });

  it("does not silently truncate multi-sentence descriptions on the first '. '", () => {
    const help = formatSkillHelp();
    expect(rowText(help, "ahood skill publish ")).toMatch(/creat(es|ing) the skill( first)? if it doesn't (already )?exist/);
  });

  // A long usage string (e.g. publish's, with every flag spelled out) wraps
  // its summary onto its own indented line(s) rather than sharing the usage
  // line -- see formatCommandTable in help.ts (ahood-cli#81). This asserts
  // the summary still appears in full somewhere in that row's block of
  // lines, not that it shares a single line with the usage.
  it("prints every skill command's summary in full within its listing block", () => {
    const help = formatSkillHelp();
    for (const entry of SKILL_COMMANDS_HELP) {
      const usage = usageWithAliases(entry);
      expect(rowText(help, usage), `expected a listing block for ${usage}`).toContain(normalizeWhitespace(entry.summary));
    }
  });

  it("every skill command's summary is a genuinely single sentence", () => {
    for (const { usage, summary } of SKILL_COMMANDS_HELP) {
      expect(summary, `${usage} summary should not embed a second sentence`).not.toContain(". ");
      expect(summary, `${usage} summary should end with exactly one period`).toMatch(/[^.]\.$/);
    }
  });

  it("has a group header and a per-command --help footer", () => {
    const help = formatSkillHelp();
    expect(help).toContain("ahood skill -- manage skills in the ahood registry");
    expect(help).toContain("ahood skill <command> --help");
  });
});

describe("formatGroupHelp", () => {
  it("includes every group command's usage line", () => {
    const help = formatGroupHelp();
    for (const entry of GROUP_COMMANDS_HELP) {
      expect(help).toContain(usageWithAliases(entry));
    }
  });

  it("has a group header and a per-command --help footer", () => {
    const help = formatGroupHelp();
    expect(help).toContain("ahood group -- create private groups");
    expect(help).toContain("ahood group <command> --help");
  });

  it("every group command's summary is a genuinely single sentence", () => {
    for (const { usage, summary } of GROUP_COMMANDS_HELP) {
      expect(summary, `${usage} summary should not embed a second sentence`).not.toContain(". ");
      expect(summary, `${usage} summary should end with exactly one period`).toMatch(/[^.]\.$/);
    }
  });
});

describe("formatHelp with the group entity", () => {
  it("points at `ahood group --help` for the full group command list, without listing group verbs individually", () => {
    const help = formatHelp();
    expect(help).toContain("ahood group <command>");
    expect(help).toContain("ahood group --help");
    const commandsSection = help.slice(help.indexOf("Commands:"));
    for (const entry of GROUP_COMMANDS_HELP) {
      expect(commandsSection).not.toContain(entry.usage);
    }
  });
});

describe("usageWithAliases", () => {
  it("folds an alias into the verb position for a skill-entity usage string", () => {
    const entry = SKILL_COMMANDS_HELP.find((c) => c.usage.startsWith("ahood skill view "));
    expect(entry).toBeDefined();
    expect(usageWithAliases(entry!)).toMatch(/^ahood skill view\|show /);
  });

  it("leaves a top-level usage string with no alias untouched", () => {
    const entry = TOP_LEVEL_COMMANDS_HELP.find((c) => c.usage === "ahood login");
    expect(entry).toBeDefined();
    expect(usageWithAliases(entry!)).toBe("ahood login");
  });
});

describe("findCommandHelp", () => {
  it("finds an exact-match top-level command (no arguments)", () => {
    expect(findCommandHelp("login")?.usage).toBe("ahood login");
  });

  it("finds a top-level command whose usage line has arguments", () => {
    expect(findCommandHelp("whoami")?.usage).toMatch(/^ahood whoami/);
  });

  it("returns undefined for a top-level command with no help entry", () => {
    expect(findCommandHelp("nonexistent")).toBeUndefined();
  });

  it("finds a skill verb via the two-token form", () => {
    expect(findCommandHelp("skill", "search")?.usage).toMatch(/^ahood skill search /);
    expect(findCommandHelp("skill", "add")?.usage).toMatch(/^ahood skill add /);
  });

  it("resolves the 'show' alias to 'view' via the two-token form", () => {
    expect(findCommandHelp("skill", "show")?.usage).toMatch(/^ahood skill view /);
  });

  it("returns undefined for a skill verb with no help entry", () => {
    expect(findCommandHelp("skill", "nonexistent")).toBeUndefined();
  });

  it("does not find old flat skill-command names at the top level", () => {
    expect(findCommandHelp("search")).toBeUndefined();
    expect(findCommandHelp("add")).toBeUndefined();
  });

  it("finds a group verb via the two-token form", () => {
    expect(findCommandHelp("group", "create")?.usage).toMatch(/^ahood group create /);
    expect(findCommandHelp("group", "list")?.usage).toMatch(/^ahood group list/);
  });

  it("returns undefined for a group verb with no help entry", () => {
    expect(findCommandHelp("group", "nonexistent")).toBeUndefined();
  });
});
