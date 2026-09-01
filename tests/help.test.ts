import { describe, expect, it } from "vitest";
import {
  formatHelp,
  formatSkillHelp,
  findCommandHelp,
  TOP_LEVEL_COMMANDS_HELP,
  SKILL_COMMANDS_HELP,
  usageWithAliases,
} from "../src/help.js";

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
    const publishLine = help.split("\n").find((l) => l.trim().startsWith("ahood skill publish "));
    expect(publishLine).toBeDefined();
    expect(publishLine).toMatch(/creat(es|ing) the skill( first)? if it doesn't (already )?exist/);
  });

  it("prints every skill command's summary in full on its listing line", () => {
    const help = formatSkillHelp();
    const commandsSection = help.slice(help.indexOf("Commands:"));
    const lines = commandsSection.split("\n").filter((l) => l.trim().length > 0 && l !== "Commands:");
    for (const { usage, summary } of SKILL_COMMANDS_HELP) {
      const line = lines.find((l) => l.trim().startsWith(usageWithAliases({ usage, summary, desc: "" }) + " ") || l.trim() === usageWithAliases({ usage, summary, desc: "" }));
      expect(line, `expected a listing line for ${usage}`).toBeDefined();
      expect(line).toContain(summary);
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
});
