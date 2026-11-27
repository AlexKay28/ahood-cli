// ahood-cli#277: prompts are written to stderr so stdout stays the data
// channel (`ahood skill remove a/b > out.txt` must not swallow the question).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { confirm, isInteractive } from "../src/confirm.js";
import { promptSecret } from "../src/secret-prompt.js";

function capture(): { out: () => string; err: () => string } {
  const sink = (into: string[]) =>
    new Writable({
      write(chunk, _enc, cb) {
        into.push(chunk.toString());
        cb();
      },
    });
  const o: string[] = [];
  const e: string[] = [];
  vi.spyOn(process, "stdout", "get").mockReturnValue(sink(o) as unknown as typeof process.stdout);
  vi.spyOn(process, "stderr", "get").mockReturnValue(sink(e) as unknown as typeof process.stderr);
  return { out: () => o.join(""), err: () => e.join("") };
}

afterEach(() => vi.restoreAllMocks());

describe("prompts write to stderr, not stdout (ahood-cli#277)", () => {
  it("confirm() prompt text is on stderr only", async () => {
    const io = capture();
    const stdin = new Readable({ read() {} });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    queueMicrotask(() => stdin.push("yes\n"));
    expect(await confirm("Type yes: ")).toBe(true);
    expect(io.err()).toContain("Type yes: ");
    expect(io.out()).toBe("");
  });

  it("masked secret input echoes '*' and erase sequences to stderr only", async () => {
    const io = capture();
    const stdin = Object.assign(new Readable({ read() {} }), {
      isTTY: true,
      setRawMode: vi.fn(),
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    const pending = promptSecret("Secret: ");
    stdin.push("abc\u007fd\n");
    expect(await pending).toBe("abd");
    expect(io.err()).toBe("Secret: ***\b \b*\n");
    expect(io.out()).toBe("");
  });

  it("isInteractive() needs stdin and stderr TTYs, and ignores a redirected stdout", () => {
    const set = (stdin: boolean, stdout: boolean, stderr: boolean) => {
      vi.spyOn(process, "stdin", "get").mockReturnValue({ isTTY: stdin } as unknown as typeof process.stdin);
      vi.spyOn(process, "stdout", "get").mockReturnValue({ isTTY: stdout } as unknown as typeof process.stdout);
      vi.spyOn(process, "stderr", "get").mockReturnValue({ isTTY: stderr } as unknown as typeof process.stderr);
    };
    set(true, false, true);
    expect(isInteractive()).toBe(true);
    set(true, true, false);
    expect(isInteractive()).toBe(false);
    set(false, true, true);
    expect(isInteractive()).toBe(false);
  });
});
