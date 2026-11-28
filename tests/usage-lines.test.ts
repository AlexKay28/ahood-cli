import { describe, expect, it, vi } from "vitest";
import { star, unstar } from "../src/commands/star.js";
import { vote } from "../src/commands/vote.js";
import { read } from "../src/commands/read.js";
import { versions } from "../src/commands/versions.js";
import { pin } from "../src/commands/pin.js";
import { main } from "../src/index.js";
import type { KindScope } from "../src/kinds.js";
import { setupEnv } from "./helpers/me-env.js";

// ahood-cli#250: a handler's usage line is the --help usage line, per noun,
// with the per-kind placeholder -- not `ahood skill ...` with the noun patched.
const scopeOf = (noun: KindScope["noun"]): KindScope => ({ noun, kind: noun });

describe("usage lines name the right command and placeholder (ahood-cli#250)", () => {
  it.each([
    ["skill", "skill"],
    ["agent", "agent"],
    ["mcp", "server"],
    ["doc", "doc"],
  ] as const)("star/unstar/vote/read/versions under %s", async (noun, ph) => {
    const scope = noun === "skill" ? undefined : scopeOf(noun);
    await expect(star([], scope)).rejects.toThrow(`Usage: ahood ${noun} star <owner>/<${ph}>`);
    await expect(unstar([], scope)).rejects.toThrow(`Usage: ahood ${noun} unstar <owner>/<${ph}>`);
    await expect(vote([], scope)).rejects.toThrow(
      `Usage: ahood ${noun} vote <owner>/<${ph}> up|down|--clear [--note <text>] [--version <x.y.z>] [--json]`,
    );
    await expect(read([], scope)).rejects.toThrow(`Usage: ahood ${noun} read <owner>/<${ph}> [--json]`);
    await expect(versions([], scope)).rejects.toThrow(`Usage: ahood ${noun} versions <owner>/<${ph}> [--json]`);
  });

  it("try prints its own usage, not `skill read`", async () => {
    const err = await read([], undefined, "try").catch((e) => e as Error);
    expect(err.message).toBe("Usage: ahood try <owner>/<slug> [--json]");
  });

  it("pin's not-installed hint does not hard-code the skill noun", async () => {
    const env = setupEnv();
    const err = await pin(["alice/nope"]).catch((e) => e as Error);
    env.restore();
    expect(err.message).toMatch(/not installed/);
    expect(err.message).toContain("`ahood <kind> add alice/nope`");
    expect(err.message).toMatch(/skill, agent, mcp, doc, project or loop/);
  });

  it("`ahood version` suggests --version, not `skill versions`", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const argv = process.argv;
    process.argv = [argv[0], argv[1], "version"];
    try {
      await expect(main()).rejects.toThrow("exit");
    } finally {
      process.argv = argv;
    }
    expect(errors.join("\n")).toContain("Did you mean 'ahood --version'?");
    expect(errors.join("\n")).not.toContain("skill versions");
    exit.mockRestore();
    vi.restoreAllMocks();
  });
});
