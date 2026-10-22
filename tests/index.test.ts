import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mocked so the "invokes the underlying handler" test below can assert on
// call args without hitting the network. Other exports of add.js are kept
// real via importOriginal, in case anything besides index.ts ever needs them.
vi.mock("../src/commands/add.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/add.js")>();
  return { ...actual, add: vi.fn(async () => {}) };
});

// Mocked so the "outdated forces --dry-run" test below can assert on call
// args without hitting the network or touching a lockfile.
vi.mock("../src/commands/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/update.js")>();
  return { ...actual, update: vi.fn(async () => {}) };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "dist", "index.js");

// These four scenarios are exercised against the real *built* CLI
// (dist/index.js), rather than by importing src/index.ts in-process,
// because what's being verified is genuinely observable process behavior --
// stdout/stderr text and the process exit code -- not an internal call.
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number | null };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

describe("ahood skill dispatch (built CLI)", () => {
  it("`ahood skill` with no args prints the skill group help and exits 0", () => {
    const { stdout, status } = runCli(["skill"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood skill -- manage skills in the ahood registry");
    expect(stdout).toContain("ahood skill search");
  });

  it("`ahood skill badverb` prints 'Unknown skill command', a did-you-mean, and exits 2", () => {
    const { stderr, status } = runCli(["skill", "badverb"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown skill command: badverb");
    expect(stderr).toContain("Run `ahood skill --help` for a list of commands.");
  });

  it("`ahood skill search --help` prints that command's specific help, not the group help", () => {
    const { stdout, status } = runCli(["skill", "search", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood skill search <query>");
    expect(stdout).toContain("Flags:");
    expect(stdout).not.toContain("ahood skill -- manage skills in the ahood registry");
  });

  it("`ahood search` (old flat form) is now an unknown top-level command, suggesting `ahood skill search`", () => {
    const { stderr, status } = runCli(["search", "pdf"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command: search");
    expect(stderr).toContain("Did you mean 'ahood skill search'?");
  });
});

describe("ahood group dispatch (built CLI)", () => {
  it("`ahood group` with no args prints the group help and exits 0", () => {
    const { stdout, status } = runCli(["group"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood group -- create private groups");
    expect(stdout).toContain("ahood group create");
  });

  it("`ahood group badverb` prints 'Unknown group command', a did-you-mean, and exits 2", () => {
    const { stderr, status } = runCli(["group", "badverb"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown group command: badverb");
    expect(stderr).toContain("Run `ahood group --help` for a list of commands.");
  });

  it("`ahood group create --help` prints that command's specific help, not the group help", () => {
    const { stdout, status } = runCli(["group", "create", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood group create <name>");
    expect(stdout).not.toContain("ahood group -- create private groups");
  });

  it("`ahood group` is registered alongside `ahood skill` at the top level", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood group <command>");
  });
});

describe("ahood snap dispatch (built CLI)", () => {
  it("`ahood snap` with no args prints the snap help and exits 0", () => {
    const { stdout, status } = runCli(["snap"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood snap -- capture and search private, session-scoped notes");
    expect(stdout).toContain("ahood snap create");
  });

  it("`ahood snap badverb` prints 'Unknown snap command', a did-you-mean, and exits 2", () => {
    const { stderr, status } = runCli(["snap", "badverb"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown snap command: badverb");
    expect(stderr).toContain("Run `ahood snap --help` for a list of commands.");
  });

  it("`ahood snap show --help` prints that command's specific help, not the group help", () => {
    const { stdout, status } = runCli(["snap", "show", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood snap show <id>");
    expect(stdout).not.toContain("ahood snap -- capture and search private, session-scoped notes");
  });

  it("`ahood snap` is registered alongside `ahood skill`/`ahood group` at the top level", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("ahood snap <command>");
  });
});

describe("plural kind alias (ahood-cli#190)", () => {
  // `ahood <kind>s` dispatches exactly as `ahood <kind>` would, for every
  // existing kind -- same group help, same unknown-verb error, same --help
  // interception path (the GROUP_COMMANDS check keys off the resolved
  // singular, not the literal word typed).
  for (const kind of ["skill", "agent", "mcp", "doc", "project"]) {
    it(`\`ahood ${kind}s\` prints the same group help as \`ahood ${kind}\``, () => {
      const plural = runCli([`${kind}s`]);
      const singular = runCli([kind]);
      expect(plural.status).toBe(singular.status);
      expect(plural.stdout).toBe(singular.stdout);
    });

    it(`\`ahood ${kind}s --help\` prints the same help as \`ahood ${kind} --help\` (not the generic top-level help)`, () => {
      const plural = runCli([`${kind}s`, "--help"]);
      const singular = runCli([kind, "--help"]);
      expect(plural.status).toBe(0);
      expect(plural.stdout).toBe(singular.stdout);
    });

    it(`an unknown verb under \`ahood ${kind}s\` fails exactly like under \`ahood ${kind}\``, () => {
      const plural = runCli([`${kind}s`, "badverb"]);
      const singular = runCli([kind, "badverb"]);
      expect(plural.status).toBe(2);
      expect(plural.stderr).toBe(singular.stderr);
    });
  }

  it("`ahood projects search ...` behaves identically to `ahood project search ...`", () => {
    const plural = runCli(["projects", "search", "--help"]);
    const singular = runCli(["project", "search", "--help"]);
    expect(plural.status).toBe(0);
    expect(plural.stdout).toBe(singular.stdout);
  });

  it("a genuine near-miss typo (`ahood projcts`) still gets the existing did-you-mean suggestion, not a false plural match", () => {
    const { stderr, status } = runCli(["projcts"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command: projcts");
    expect(stderr).toContain("Did you mean 'project'?");
  });

  it("no top-level command collides with a plural kind alias", async () => {
    const { COMMANDS } = await import("../src/index.js");
    const collisions = Object.keys(COMMANDS).filter((name) => name.endsWith("s"));
    expect(collisions).toEqual([]);
  });

  it("`ahood snaps`/`ahood groups` are not kind plurals and still fail as unknown commands (group/snap are entities, not kinds)", () => {
    for (const bad of ["snaps", "groups"]) {
      const { status, stderr } = runCli([bad]);
      expect(status).toBe(2);
      expect(stderr).toContain(`Unknown command: ${bad}`);
    }
  });
});

describe("invocation via a symlink (how npm's installed `ahood` bin actually works)", () => {
  // Regression test for a real incident: npm's installed bin is a symlink
  // to dist/index.js (`npm install -g` / npx both create one), not a copy.
  // Node resolves the symlink when computing import.meta.url but does NOT
  // resolve it in process.argv[1] -- an entrypoint guard that compares
  // those two raw strings (`import.meta.url === file://${process.argv[1]}`)
  // silently NEVER matches for any real npm-installed invocation, so
  // main() never ran: every command exited 0 with zero output. This test
  // invokes the built CLI through a real symlink, exactly reproducing how
  // npm links the `ahood` binary, so this class of bug can't ship silently
  // again -- runCli() above (invoking dist/index.js directly) cannot catch
  // it, since process.argv[1] equals import.meta.url's path exactly when
  // there's no symlink in between.
  it("prints real output when invoked through a symlink, not silently no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ahood-symlink-test-"));
    const linkPath = path.join(dir, "ahood");
    try {
      symlinkSync(cliPath, linkPath);
      // Invoking `node <symlink>` (rather than executing the symlink
      // directly via its shebang) reproduces the identical argv[1]-vs-
      // import.meta.url mismatch without depending on the sandbox allowing
      // direct execution of a freshly created temp binary -- process.argv[1]
      // is the unresolved symlink path either way, which is the only thing
      // that matters for this regression.
      const stdout = execFileSync(process.execPath, [linkPath, "--version"], { encoding: "utf8" });
      expect(stdout.trim().length).toBeGreaterThan(0);
      expect(stdout).toMatch(/^@ahood\/cli \d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatchSkill (in-process)", () => {
  it("`ahood skill add ...` invokes the underlying add handler with the sliced args", async () => {
    const { add } = await import("../src/commands/add.js");
    const { dispatchSkill } = await import("../src/index.js");

    await dispatchSkill(["add", "alice/pdf-tools", "--json"]);

    expect(add).toHaveBeenCalledWith(["alice/pdf-tools", "--json"]);
  });

  it("`ahood skill outdated ...` reaches update()'s existing dry-run path by forcing --dry-run onto whatever args were given", async () => {
    const { update } = await import("../src/commands/update.js");
    const { dispatchSkill } = await import("../src/index.js");

    await dispatchSkill(["outdated", "alice/pdf-tools", "--json"]);

    expect(update).toHaveBeenCalledWith(["alice/pdf-tools", "--json", "--dry-run"]);
  });

  it("`ahood skill outdated` with no args still forces --dry-run", async () => {
    const { update } = await import("../src/commands/update.js");
    const { dispatchSkill } = await import("../src/index.js");

    await dispatchSkill(["outdated"]);

    expect(update).toHaveBeenCalledWith(["--dry-run"]);
  });
});

describe("dispatchGroup (in-process)", () => {
  it("`ahood group list ...` invokes the underlying handler with the sliced args", async () => {
    const { dispatchGroup, GROUP_VERBS } = await import("../src/index.js");
    const spy = vi.spyOn(GROUP_VERBS, "list").mockImplementation(async () => {});

    await dispatchGroup(["list", "--json"]);

    expect(spy).toHaveBeenCalledWith(["--json"]);
    spy.mockRestore();
  });
});

describe("dispatchSnap (in-process)", () => {
  it("`ahood snap list ...` invokes the underlying handler with the sliced args", async () => {
    const { dispatchSnap, SNAP_VERBS } = await import("../src/index.js");
    const spy = vi.spyOn(SNAP_VERBS, "list").mockImplementation(async () => {});

    await dispatchSnap(["list", "--json"]);

    expect(spy).toHaveBeenCalledWith(["--json"]);
    spy.mockRestore();
  });
});
