import { describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { promptSecret } from "../src/secret-prompt.js";

function stubStdio(answer: string | null): { promptedWith(): string } {
  const written: string[] = [];
  const fakeStdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { fd: 0 };
  const fakeStdout = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream & { fd: 1 };
  vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(fakeStdout);
  queueMicrotask(() => {
    if (answer !== null) fakeStdin.push(`${answer}\n`);
    fakeStdin.push(null);
  });
  return { promptedWith: () => written.join("") };
}

describe("promptSecret", () => {
  it("resolves with the line typed on non-interactive stdin", async () => {
    const stdio = stubStdio("sk-my-secret-value");
    const result = await promptSecret("Enter a value: ");
    expect(result).toBe("sk-my-secret-value");
    expect(stdio.promptedWith()).toContain("Enter a value: ");
  });

  it("rejects instead of resolving with an empty string when stdin closes with no answer", async () => {
    stubStdio(null);
    await expect(promptSecret("Enter a value: ")).rejects.toThrow(/not answered/);
  });
});
