import { describe, expect, it, vi } from "vitest";
import { completion } from "../src/commands/completion.js";

async function captured(shell: string): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  await completion([shell]);
  const output = logSpy.mock.calls[0][0] as string;
  logSpy.mockRestore();
  return output;
}

describe("completion", () => {
  it("rejects an unsupported shell", async () => {
    await expect(completion(["powershell"])).rejects.toThrow(/Usage: ahood completion/);
  });

  it("bash: position 1 completes top-level words (account commands + skill), not skill verbs", async () => {
    const output = await captured("bash");
    expect(output).toContain("complete -F _ahood_completions ahood");
    const topLine = output.split("\n").find((l) => l.includes("top_words="));
    expect(topLine).toBeDefined();
    for (const name of ["login", "logout", "whoami", "token", "completion", "skill"]) {
      expect(topLine).toContain(name);
    }
    expect(topLine).not.toMatch(/\bsearch\b/);
    expect(topLine).not.toMatch(/\bpublish\b/);
    expect(topLine).not.toMatch(/\bshow\b/);
  });

  it("bash: position 2+ after 'skill' completes skill verbs and the show alias", async () => {
    const output = await captured("bash");
    const skillLine = output.split("\n").find((l) => l.includes("skill_words="));
    expect(skillLine).toBeDefined();
    for (const name of ["search", "add", "publish", "list", "show"]) {
      expect(skillLine).toContain(name);
    }
    expect(output).toContain('"${COMP_WORDS[1]}" == "skill"');
  });

  it("zsh: prints a compdef header and position-aware command arrays", async () => {
    const output = await captured("zsh");
    expect(output).toContain("#compdef ahood");
    const topLine = output.split("\n").find((l) => l.trim().startsWith("top_cmds="));
    const skillLine = output.split("\n").find((l) => l.trim().startsWith("skill_cmds="));
    expect(topLine).toContain("skill");
    expect(topLine).not.toMatch(/\bsearch\b/);
    expect(skillLine).toContain("search");
    expect(skillLine).toContain("show");
  });

  it("fish: top-level completions use __fish_use_subcommand; skill completions gate on __fish_seen_subcommand_from skill", async () => {
    const output = await captured("fish");
    const lines = output.split("\n");
    const topLines = lines.filter((l) => l.includes("__fish_use_subcommand"));
    const skillLines = lines.filter((l) => l.includes("__fish_seen_subcommand_from skill"));

    expect(topLines.some((l) => l.includes('-a "skill"'))).toBe(true);
    expect(topLines.some((l) => l.includes('-a "login"'))).toBe(true);
    expect(topLines.some((l) => l.includes('-a "search"'))).toBe(false);
    expect(topLines.some((l) => l.includes('-a "show"'))).toBe(false);

    expect(skillLines.some((l) => l.includes('-a "search"'))).toBe(true);
    expect(skillLines.some((l) => l.includes('-a "add"'))).toBe(true);
    expect(skillLines.some((l) => l.includes('-a "publish"'))).toBe(true);
    expect(skillLines.some((l) => l.includes('-a "show"'))).toBe(true);
  });
});
