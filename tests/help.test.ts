import { describe, expect, it } from "vitest";
import { formatHelp, findCommandHelp, COMMANDS_HELP } from "../src/help.js";

describe("formatHelp", () => {
  it("includes every command's usage line and a quick-start section", () => {
    const help = formatHelp();
    for (const { usage } of COMMANDS_HELP) {
      expect(help).toContain(usage);
    }
    expect(help).toContain("Quick start:");
    expect(help).toContain("ahood login");
  });

  it("does not silently truncate multi-sentence descriptions on the first '. '", () => {
    const help = formatHelp();
    const publishLine = help.split("\n").find((l) => l.trim().startsWith("ahood publish "));
    expect(publishLine).toBeDefined();
    expect(publishLine).toMatch(/creat(es|ing) the skill( first)? if it doesn't (already )?exist/);
  });

  it("prints every command's summary in full on its listing line", () => {
    const help = formatHelp();
    const commandsSection = help.slice(help.indexOf("Commands:"));
    const lines = commandsSection.split("\n").filter((l) => l.trim().length > 0 && l !== "Commands:");
    for (const { usage, summary } of COMMANDS_HELP) {
      const line = lines.find((l) => l.trim().startsWith(`${usage} `) || l.trim() === usage);
      expect(line, `expected a listing line for ${usage}`).toBeDefined();
      expect(line).toContain(summary);
    }
  });

  it("every command's summary is a genuinely single sentence", () => {
    for (const { usage, summary } of COMMANDS_HELP) {
      expect(summary, `${usage} summary should not embed a second sentence`).not.toContain(". ");
      expect(summary, `${usage} summary should end with exactly one period`).toMatch(/[^.]\.$/);
    }
  });
});

describe("findCommandHelp", () => {
  it("finds an exact-match command (no arguments)", () => {
    expect(findCommandHelp("login")?.usage).toBe("ahood login");
  });

  it("finds a command whose usage line has arguments", () => {
    expect(findCommandHelp("edit")?.usage).toMatch(/^ahood edit /);
    expect(findCommandHelp("add")?.usage).toMatch(/^ahood add /);
  });

  it("returns undefined for a command with no help entry", () => {
    expect(findCommandHelp("nonexistent")).toBeUndefined();
  });
});
