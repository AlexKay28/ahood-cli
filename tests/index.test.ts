import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mocked so the "invokes the underlying handler" test below can assert on
// call args without hitting the network. Other exports of add.js are kept
// real via importOriginal, in case anything besides index.ts ever needs them.
vi.mock("../src/commands/add.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/add.js")>();
  return { ...actual, add: vi.fn(async () => {}) };
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

describe("dispatchSkill (in-process)", () => {
  it("`ahood skill add ...` invokes the underlying add handler with the sliced args", async () => {
    const { add } = await import("../src/commands/add.js");
    const { dispatchSkill } = await import("../src/index.js");

    await dispatchSkill(["add", "alice/pdf-tools", "--json"]);

    expect(add).toHaveBeenCalledWith(["alice/pdf-tools", "--json"]);
  });
});
