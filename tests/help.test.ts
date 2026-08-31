import { describe, expect, it } from "vitest";
import { formatHelp, findCommandHelp, COMMANDS_HELP, usageWithAliases } from "../src/help.js";

describe("formatHelp", () => {
  it("includes every command's usage line (aliases folded in) and a quick-start section", () => {
    const help = formatHelp();
    for (const entry of COMMANDS_HELP) {
      expect(help).toContain(usageWithAliases(entry));
    }
    expect(help).toContain("Quick start:");
    expect(help).toContain("ahood login");
  });

  it("surfaces the 'show' alias next to 'view' so it isn't invisible in the top-level listing", () => {
    const help = formatHelp();
    expect(help).toMatch(/ahood view\|show\b/);
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
