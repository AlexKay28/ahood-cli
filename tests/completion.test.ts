import { describe, expect, it, vi } from "vitest";
import { completion } from "../src/commands/completion.js";

describe("completion", () => {
  it("rejects an unsupported shell", async () => {
    await expect(completion(["powershell"])).rejects.toThrow(/Usage: ahood completion/);
  });

  it("prints a bash completion function listing the command names", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await completion(["bash"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("complete -F _ahood_completions ahood"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("search"));
    logSpy.mockRestore();
  });

  it("prints zsh and fish completions too", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await completion(["zsh"]);
    await completion(["fish"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("#compdef ahood"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("complete -c ahood"));
    logSpy.mockRestore();
  });
});
