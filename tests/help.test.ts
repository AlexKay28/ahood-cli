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
