import { describe, expect, it, vi } from "vitest";
import { star, unstar } from "../src/commands/star.js";
import { vote } from "../src/commands/vote.js";
import { read } from "../src/commands/read.js";
import { versions } from "../src/commands/versions.js";
import { pin } from "../src/commands/pin.js";
import { add } from "../src/commands/add.js";
import { diff } from "../src/commands/diff.js";
import { edit } from "../src/commands/edit.js";
import { init } from "../src/commands/init.js";
import { listSkills } from "../src/commands/list.js";
import { publish } from "../src/commands/publish.js";
import { remove } from "../src/commands/remove.js";
import { search } from "../src/commands/search.js";
import { share, unshare } from "../src/commands/share.js";
import { unpublish } from "../src/commands/unpublish.js";
import { update } from "../src/commands/update.js";
import { view } from "../src/commands/view.js";
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

  // ahood-cli#280: the rest of the handlers, each fed bad args (no network).
  it.each([
    ["skill", "skill"],
    ["agent", "agent"],
    ["mcp", "server"],
  ] as const)("every other verb under %s names its noun and placeholder", async (noun, ph) => {
    const scope = noun === "skill" ? undefined : scopeOf(noun);
    const o = `<owner>/<${ph}>`;
    const cases: [string, () => Promise<unknown>, string][] = [
      ["add", () => add([], scope), `Usage: ahood ${noun} add ${o}[@version]`],
      ["diff", () => diff([], scope), `Usage: ahood ${noun} diff ${o} <versionA> <versionB> [--json]`],
      ["edit", () => edit([], scope), `Usage: ahood ${noun} edit ${o} [--tagline <text>]`],
      ["init", () => init(["--bogus"], scope), `Usage: ahood ${noun} init [name]`],
      ["list", () => listSkills(["x"], scope), `Usage: ahood ${noun} list [--json]`],
      ["publish", () => publish([], scope), `Usage: ahood ${noun} publish ${o}@<version>`],
      ["publish legacy", () => publish([], scope), `or: ahood ${noun} publish <path> --owner <owner> --slug <${ph}>`],
      ["remove", () => remove([], scope), `Usage: ahood ${noun} remove ${o} [--yes]`],
      ["search", () => search([], scope), `Usage: ahood ${noun} search <query>`],
      ["share", () => share([], scope), `Usage: ahood ${noun} share ${o} --group <group>`],
      ["unshare", () => unshare([], scope), `Usage: ahood ${noun} unshare ${o} --group <group>`],
      ["unpublish", () => unpublish([], scope), `Usage: ahood ${noun} unpublish ${o}[@version] [--yes]`],
      ["update", () => update(["a/b", "--bogus"], scope), `Usage: ahood ${noun} update [${o} ...]`],
      ["view", () => view([], scope), `Usage: ahood ${noun} view ${o} [--json] [--web]`],
    ];
    for (const [verb, p, expected] of cases) {
      const err = await p().catch((e) => e as Error);
      expect(err, verb).toBeInstanceOf(Error);
      expect((err as Error).message, verb).toContain(expected);
      if (noun !== "skill") expect((err as Error).message, verb).not.toContain("ahood skill");
    }
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
