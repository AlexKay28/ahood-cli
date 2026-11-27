// ahood-cli#257: a prompt on a stdin that is not a terminal must never wait
// unboundedly. An open-but-silent pipe is the normal stdin under agent and CI
// runners, and before this the prompt sat on it until something killed the
// process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { NON_TTY_ANSWER_TIMEOUT_MS, PromptUnansweredError, askLine, confirm } from "../src/confirm.js";
import { promptSecret } from "../src/secret-prompt.js";
import { resolveMcpServerConfig } from "../src/commands/add.js";
import { exitCodeFor } from "../src/exit-code.js";
import { UsageError } from "../src/usage-error.js";

type FakeStdin = Readable & { ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };

// A non-TTY stdin that stays open and says nothing until the test pushes to
// it -- the shape `sleep 30 | ahood ...` gives the real process.
function stubStdio(): { stdin: FakeStdin; written(): string } {
  const written: string[] = [];
  const stdin = Object.assign(new Readable({ read() {} }), { ref: vi.fn(), unref: vi.fn() }) as FakeStdin;
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
  return { stdin, written: () => written.join("") };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("confirm() on a non-TTY stdin (ahood-cli#257)", () => {
  it("rejects once the bound elapses on a stdin that stays open and silent, and lets go of stdin", async () => {
    vi.useFakeTimers();
    const { stdin } = stubStdio();
    const pending = confirm('Type "yes" to confirm: ');
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(NON_TTY_ANSWER_TIMEOUT_MS - 1);
    expect(await Promise.race([outcome, Promise.resolve("still waiting")])).toBe("still waiting");

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(PromptUnansweredError);
    expect(error).toBeInstanceOf(UsageError);
    expect(exitCodeFor(error)).toBe(2);
    expect((error as Error).message).toMatch(/not answered/);
    expect((error as Error).message).toContain("--yes");

    // Nothing left that could keep the process alive or eat later input.
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.isPaused()).toBe(true);
    expect(stdin.unref).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a piped yes and leaves no timer or stdin reference behind", async () => {
    vi.useFakeTimers();
    const { stdin } = stubStdio();
    const pending = confirm('Type "yes" to confirm: ');
    stdin.push("yes\n");
    await expect(pending).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(stdin.unref).toHaveBeenCalled();
  });

  it("treats a piped no as a refusal, not as an unanswered prompt", async () => {
    const { stdin } = stubStdio();
    const pending = confirm('Type "yes" to confirm: ');
    stdin.push("n\n");
    await expect(pending).resolves.toBe(false);
  });

  it("still rejects at once when stdin closes without an answer, now naming --yes", async () => {
    const { stdin } = stubStdio();
    const pending = confirm('Type "yes" to confirm: ');
    stdin.push(null);
    await expect(pending).rejects.toThrow(/not answered \(stdin closed\).*--yes/);
  });

  it("does not wait out the bound again on a stdin already shown to be silent", async () => {
    vi.useFakeTimers();
    stubStdio();
    const first = confirm("first? ").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(NON_TTY_ANSWER_TIMEOUT_MS);
    expect(await first).toBeInstanceOf(PromptUnansweredError);

    // No timers advanced: this one has to settle on its own.
    await expect(askLine("second? ")).rejects.toBeInstanceOf(PromptUnansweredError);
  });

  it("rejects instead of never settling when stdin had already ended before the prompt", async () => {
    const { stdin } = stubStdio();
    stdin.push(null);
    stdin.resume();
    await new Promise((done) => stdin.once("end", done));
    await expect(confirm("late? ")).rejects.toThrow(/stdin closed/);
  });
});

describe("promptSecret() on a non-TTY stdin (ahood-cli#257)", () => {
  it("rejects within the bound on a silent stdin", async () => {
    vi.useFakeTimers();
    stubStdio();
    const outcome = promptSecret("WEATHER_API_KEY (key): ").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(NON_TTY_ANSWER_TIMEOUT_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(PromptUnansweredError);
    expect(exitCodeFor(error)).toBe(2);
  });

  it("still takes a piped value verbatim", async () => {
    const { stdin } = stubStdio();
    const pending = promptSecret("WEATHER_API_KEY (key): ");
    stdin.push(" sk-piped \n");
    await expect(pending).resolves.toBe(" sk-piped ");
  });
});

describe("mcp secrets on `add` with nobody to answer (ahood-cli#257)", () => {
  function tarGz(files: Record<string, string>): Promise<Buffer> {
    const tar = pack();
    for (const [name, content] of Object.entries(files)) tar.entry({ name }, content);
    tar.finalize();
    const chunks: Buffer[] = [];
    return new Promise((done, reject) => {
      tar.on("data", (chunk) => chunks.push(chunk as Buffer));
      tar.on("end", () => done(gzipSync(Buffer.concat(chunks))));
      tar.on("error", reject);
    });
  }

  function manifest(envVars: Array<Record<string, unknown>>): Promise<Buffer> {
    return tarGz({
      "server.json": JSON.stringify({
        name: "weather-server",
        description: "d",
        packages: [
          { registry_type: "npm", identifier: "@example/weather-mcp-server", version: "1.4.0", runtime_hint: "npx", environment_variables: envVars },
        ],
      }),
    });
  }

  it("fails on a required secret, naming the variable, instead of hanging", async () => {
    vi.useFakeTimers();
    stubStdio();
    vi.stubEnv("WEATHER_API_KEY", "");
    const archive = await manifest([{ name: "WEATHER_API_KEY", description: "key", is_required: true, is_secret: true }]);
    const outcome = resolveMcpServerConfig(archive).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(NON_TTY_ANSWER_TIMEOUT_MS);
    const error = await outcome;
    expect(exitCodeFor(error)).toBe(2);
    expect((error as Error).message).toMatch(/WEATHER_API_KEY is required by weather-server .*export WEATHER_API_KEY and re-run/);
    vi.unstubAllEnvs();
  });

  it("skips optional secrets with a name-only notice, waiting out the bound only once", async () => {
    vi.useFakeTimers();
    stubStdio();
    vi.stubEnv("WEATHER_ORG_TOKEN", "");
    vi.stubEnv("WEATHER_TEAM_TOKEN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = await manifest([
      { name: "WEATHER_ORG_TOKEN", description: "org", is_required: false, is_secret: true },
      { name: "WEATHER_TEAM_TOKEN", description: "team", is_required: false, is_secret: true },
    ]);
    const pending = resolveMcpServerConfig(archive);
    // One bound, not two: the second prompt must not wait again.
    await vi.advanceTimersByTimeAsync(NON_TTY_ANSWER_TIMEOUT_MS);
    const { serverConfig } = await pending;
    expect(serverConfig.env ?? {}).toEqual({});
    const notices = warn.mock.calls.map((call) => String(call[0]));
    expect(notices.some((line) => /WEATHER_ORG_TOKEN is optional and is not set/.test(line))).toBe(true);
    expect(notices.some((line) => /WEATHER_TEAM_TOKEN is optional and is not set/.test(line))).toBe(true);
    vi.unstubAllEnvs();
  });
});

// The built CLI end to end, with stdin held open and silent for the whole
// run -- the unit tests above use a fake stream and fake timers, so this is
// the one place that proves the real process actually exits.
describe("built CLI under an open, silent stdin pipe (ahood-cli#257)", () => {
  const cliPath = resolve(__dirname, "..", "dist", "index.js");

  function run(args: string[], cwd: string, feed?: string) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; ms: number }>((done) => {
      const started = Date.now();
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd,
        env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: join(cwd, ".config"), AHOOD_API_URL: "http://registry.invalid", AHOOD_TOKEN: "t" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdout.resume();
      // Deliberately never ended: only the kill below closes it, and only
      // if the CLI failed to exit on its own.
      if (feed !== undefined) child.stdin.write(feed);
      const killer = setTimeout(() => child.kill("SIGKILL"), NON_TTY_ANSWER_TIMEOUT_MS + 10_000);
      child.on("exit", (code, signal) => {
        clearTimeout(killer);
        child.stdin.destroy();
        done({ code, signal, stderr, ms: Date.now() - started });
      });
    });
  }

  function projectWithInstalledSkill(): { dir: string; skillPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "ahood-cli-257-"));
    const skillPath = join(dir, ".claude", "skills", "x@y");
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(join(skillPath, "SKILL.md"), "# y\n");
    return { dir, skillPath };
  }

  it("`skill remove` exits 2 shortly after the bound, removing nothing", async () => {
    const { dir, skillPath } = projectWithInstalledSkill();
    try {
      const result = await run(["skill", "remove", "x/y"], dir);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--yes");
      expect(result.ms).toBeLessThan(NON_TTY_ANSWER_TIMEOUT_MS + 8_000);
      expect(existsSync(skillPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("`skill remove` answered over a pipe that then stays open still exits, having removed it", async () => {
    const { dir, skillPath } = projectWithInstalledSkill();
    try {
      const result = await run(["skill", "remove", "x/y"], dir, "yes\n");
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);
      expect(existsSync(skillPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
