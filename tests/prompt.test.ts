// ahood-cli#206 (AlexKay28/ahood#1007): `ahood prompt`, the seventh registry
// noun. A prompt is never installed: `get` fills its PROMPT.md and prints it,
// add/update/outdated/remove are refused before any request, and publish
// checks the placeholder rules locally before uploading. The PROMPT.md
// contract itself is tests/prompt-doc.test.ts (the server's fixture, ported).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPrompt, dispatchSkill } from "../src/index.js";
import { parsePromptGetArgs } from "../src/commands/prompt-get.js";
import { KindMismatchError } from "../src/kinds.js";
import { UsageError } from "../src/usage-error.js";
import { exitCodeFor } from "../src/exit-code.js";
import { API_URL, entry, fakeRegistry, json, mutations, type Call } from "./helpers/fake-registry.js";

vi.mock("../src/confirm.js", () => ({ confirm: vi.fn(async () => true) }));

// The issue's example, which is also the server fixture's.
const PROMPT_MD = `---
name: brutalist-landing-page
intent: Generate a single-page site in a brutalist style from a product one-liner
inputs:
  - key: product
    label: What the product is, one sentence
  - key: audience
    label: Who it is for
    default: developers
works_with: [claude-code, codex, cursor, chatgpt]   # informational
---
You are designing a landing page for {{product}}, aimed at {{ audience }}.
Keep {{product}} in the headline.
`;

const INPUTS = [
  { key: "product", label: "What the product is, one sentence", default: null },
  { key: "audience", label: "Who it is for", default: "developers" },
];

// A fake of the two read routes `get` uses: the entry's detail (latest) and
// one version row. `kind` is what the registry reports for alice/landing.
function fakePromptRegistry(opts: { kind?: string; content?: string; version?: string } = {}): Call[] {
  const calls: Call[] = [];
  const kind = opts.kind ?? "prompt";
  const version = opts.version ?? "1.2.0";
  const row = { version, skill_md_content: opts.content ?? PROMPT_MD, yanked_at: null, yanked_reason: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ method: (init.method ?? "GET").toUpperCase(), url: String(input) });
      if (url.pathname === "/api/v1/skills/alice/landing") {
        return json({ owner: "alice", slug: "landing", kind, skill_versions: row });
      }
      if (url.pathname.startsWith("/api/v1/skills/alice/landing/versions/")) {
        const v = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return json({ ...row, version: v, status: "published", kind });
      }
      return json({ error: "Not found" }, 404);
    }),
  );
  return calls;
}

function captureStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function written(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e as Error,
  );
}

describe("ahood prompt (ahood-cli#206)", () => {
  let dir: string;
  let originalCwd: string;
  const saved = { HOME: process.env.HOME, AHOOD_API_URL: process.env.AHOOD_API_URL, AHOOD_TOKEN: process.env.AHOOD_TOKEN, PATH: process.env.PATH };

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ahood-prompt-test-"));
    process.chdir(dir);
    process.env.HOME = dir;
    process.env.AHOOD_API_URL = API_URL;
    delete process.env.AHOOD_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("get", () => {
    it("fills the prompt, falling back to the default, and prints only the text", async () => {
      fakePromptRegistry();
      const stdout = captureStdout();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchPrompt(["get", "alice/landing", "--product", "a CLI"]);
      expect(written(stdout)).toBe("You are designing a landing page for a CLI, aimed at developers.\nKeep a CLI in the headline.\n");
      expect(log).not.toHaveBeenCalled();
    });

    it("uses a given value over the default, in both --key value and --key=value forms; an empty value falls back", async () => {
      fakePromptRegistry();
      const stdout = captureStdout();
      await dispatchPrompt(["get", "alice/landing", "--product=a CLI", "--audience", "designers"]);
      expect(written(stdout)).toContain("for a CLI, aimed at designers.");
      stdout.mockClear();
      await dispatchPrompt(["get", "--audience=", "--product", "p", "alice/landing"]);
      expect(written(stdout)).toContain("aimed at developers.");
    });

    it("is one pass: a value containing {{x}} is inserted verbatim", async () => {
      fakePromptRegistry();
      const stdout = captureStdout();
      await dispatchPrompt(["get", "alice/landing", "--product", "{{audience}}"]);
      expect(written(stdout)).toContain("landing page for {{audience}}, aimed at developers.");
    });

    it("a missing required input exits 2 naming the key and its label, printing nothing", async () => {
      fakePromptRegistry();
      const stdout = captureStdout();
      for (const args of [["get", "alice/landing"], ["get", "alice/landing", "--product", ""], ["get", "alice/landing", "--audience", "x"]]) {
        const error = await rejection(dispatchPrompt(args));
        expect(error).toBeInstanceOf(UsageError);
        expect(exitCodeFor(error)).toBe(2);
        expect(error.message).toBe("Missing required input: product (What the product is, one sentence)");
      }
      expect(stdout).not.toHaveBeenCalled();
    });

    it("an unknown --key is a usage error that names it and lists the declared keys", async () => {
      fakePromptRegistry();
      const stdout = captureStdout();
      const error = await rejection(dispatchPrompt(["get", "alice/landing", "--product", "p", "--tone", "dry"]));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toBe("Unknown input: tone; this prompt declares product, audience");
      // --kind is not consumed by the dispatcher for `get`: it is an input name like any other.
      const kindError = await rejection(dispatchPrompt(["get", "alice/landing", "--kind", "skill", "--x=1"]));
      expect(kindError.message).toBe("Unknown inputs: kind, x; this prompt declares product, audience");
      expect(stdout).not.toHaveBeenCalled();
    });

    it("--json prints the get_prompt MCP tool's payload", async () => {
      fakePromptRegistry();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchPrompt(["get", "alice/landing", "--product", "a CLI", "--json"]);
      expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
        owner: "alice",
        slug: "landing",
        name: "brutalist-landing-page",
        intent: "Generate a single-page site in a brutalist style from a product one-liner",
        version: "1.2.0",
        inputs: INPUTS,
        works_with: ["claude-code", "codex", "cursor", "chatgpt"],
        text: "You are designing a landing page for a CLI, aimed at developers.\nKeep a CLI in the headline.\n",
      });
    });

    it("@version reads that version's row", async () => {
      const calls = fakePromptRegistry();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchPrompt(["get", "alice/landing@1.0.0", "--product", "p", "--json"]);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/skills/alice/landing/versions/1.0.0"]);
      expect(JSON.parse(log.mock.calls[0][0] as string).version).toBe("1.0.0");
    });

    describe("--copy", () => {
      // A stub clipboard tool on an otherwise empty PATH: `xclip` (the last
      // candidate, so every earlier one is genuinely absent) writes its stdin
      // and argv to files the test reads back.
      function stubClipboard(): string {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        const script = join(bin, "xclip");
        writeFileSync(script, `#!/bin/sh\necho "$@" > "${join(dir, "clip-args")}"\n/bin/cat > "${join(dir, "clip")}"\n`);
        chmodSync(script, 0o755);
        return bin;
      }

      it("copies the filled text to the clipboard and confirms on stderr, printing nothing on stdout", async () => {
        fakePromptRegistry();
        process.env.PATH = stubClipboard();
        const stdout = captureStdout();
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        await dispatchPrompt(["get", "alice/landing", "--product", "a CLI", "--copy"]);
        expect(readFileSync(join(dir, "clip"), "utf8")).toBe(
          "You are designing a landing page for a CLI, aimed at developers.\nKeep a CLI in the headline.\n",
        );
        expect(readFileSync(join(dir, "clip-args"), "utf8").trim()).toBe("-selection clipboard");
        expect(err).toHaveBeenCalledWith("Copied alice/landing@1.2.0 to the clipboard (xclip).");
        expect(stdout).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      });

      it("with no clipboard tool, fails non-zero and says so instead of printing the text", async () => {
        fakePromptRegistry();
        const empty = join(dir, "empty-bin");
        mkdirSync(empty);
        process.env.PATH = empty;
        const stdout = captureStdout();
        const error = await rejection(dispatchPrompt(["get", "alice/landing", "--product", "p", "--copy"]));
        expect(error.message).toMatch(/^Could not copy to the clipboard: none of pbcopy, clip, wl-copy or xclip is installed/);
        expect(exitCodeFor(error)).not.toBe(0);
        expect(stdout).not.toHaveBeenCalled();
      });
    });

    it("refuses a target of another kind before filling anything", async () => {
      fakePromptRegistry({ kind: "skill" });
      const stdout = captureStdout();
      const error = await rejection(dispatchPrompt(["get", "alice/landing", "--product", "p"]));
      expect(error).toBeInstanceOf(KindMismatchError);
      expect(error.message).toBe(
        "alice/landing is a skill, not a prompt -- refusing to fill it. Use `ahood skill read alice/landing` instead.",
      );
      expect(stdout).not.toHaveBeenCalled();
    });

    it("rejects malformed arguments before any request", async () => {
      const calls = fakePromptRegistry();
      for (const [args, message] of [
        [[], /^Usage: ahood prompt get/],
        [["alice/landing", "--product"], /^--product requires a value/],
        [["alice/landing", "--product", "--copy"], /^--product requires a value/],
        [["alice/landing", "--product", "a", "--product", "b"], /^--product given more than once/],
        [["alice/landing", "--copy", "--json"], /^Pass --copy or --json, not both/],
        [["alice/landing", "extra"], /^Unexpected argument "extra"/],
      ] as Array<[string[], RegExp]>) {
        expect(() => parsePromptGetArgs(args)).toThrow(message);
        await expect(dispatchPrompt(["get", ...args])).rejects.toThrow(UsageError);
      }
      await expect(dispatchPrompt(["get", "alice/.."])).rejects.toThrow(/Invalid skill/);
      expect(calls).toEqual([]);
    });
  });

  describe("a prompt is never installed", () => {
    it("add, update, outdated and remove are refused with a pointer to get, before any request or write", async () => {
      const calls = fakeRegistry({ "alice/landing": await entry("prompt") });
      for (const args of [
        ["add", "alice/landing"],
        ["update", "alice/landing"],
        ["update"],
        ["outdated"],
        ["remove", "alice/landing", "--yes"],
      ]) {
        const error = await rejection(dispatchPrompt(args));
        expect(error).toBeInstanceOf(UsageError);
        expect(error.message).toBe(
          `Prompts are never installed, so there is nothing to ${args[0]}. ` +
            "Use `ahood prompt get <owner>/<prompt> [--<key> <value> ...]` to fill one in and print it.",
        );
      }
      // The same refusal through `--kind prompt` on the legacy noun.
      await expect(dispatchSkill(["add", "alice/landing", "--kind", "prompt"])).rejects.toThrow(/^Prompts are never installed/);
      expect(calls).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("legacy `ahood skill add` of a prompt is refused before the download, pointing at prompt get", async () => {
      const calls = fakeRegistry({ "alice/landing": await entry("prompt") });
      const error = await rejection(dispatchSkill(["add", "alice/landing"]));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toBe(
        "alice/landing is a prompt (a one-shot prompt with declared inputs, filled in and pasted once), not a skill, and is never installed. " +
          "Fill it in and print it with `ahood prompt get alice/landing`.",
      );
      expect(mutations(calls)).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    });

    it("the read verbs are shared: search and list ask for kind=prompt, read prints the PROMPT.md", async () => {
      const calls = fakeRegistry({ "alice/landing": await entry("prompt") }, []);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const stdout = captureStdout();
      await dispatchPrompt(["search", "landing"]);
      expect(new URL(calls[0].url).searchParams.get("kind")).toBe("prompt");
      await dispatchPrompt(["list", "--json"]);
      expect(new URL(calls[1].url).searchParams.get("kind")).toBe("prompt");
      await dispatchPrompt(["read", "alice/landing"]);
      expect(written(stdout)).toBe("doc"); // fake-registry's skill_md_content sentinel
      await dispatchPrompt(["view", "alice/landing", "--json"]);
      expect(mutations(calls)).toEqual([]);
    });
  });

  describe("init and publish", () => {
    it("`ahood prompt init <name>` scaffolds a PROMPT.md with one input that publish accepts", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatchPrompt(["init", "landing"]);
      const content = readFileSync(join("landing", "PROMPT.md"), "utf8");
      const { parsePromptDoc } = await import("../src/prompt-doc.js");
      const parsed = parsePromptDoc(content);
      expect(parsed.ok && parsed.prompt.inputs).toEqual([{ key: "topic", label: "TODO -- what to fill in here", default: null }]);
    });

    it("`ahood skill publish` detects PROMPT.md and creates a prompt entry", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      mkdirSync("p");
      writeFileSync(join("p", "PROMPT.md"), PROMPT_MD);
      const calls = fakeRegistry({});
      await dispatchSkill(["publish", "alice/landing@1.0.0", "--path", "p", "--name", "Landing"]);
      const create = calls.find((c) => c.method === "POST" && new URL(c.url).pathname === "/api/v1/skills");
      expect(JSON.parse(create!.body!)).toMatchObject({ slug: "landing", name: "Landing", kind: "prompt" });
    });

    it("an undeclared {{key}}, or a declared input the body never uses, fails publish before any request, naming the key", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      mkdirSync("p");
      const calls = fakeRegistry({});
      const cases: Array<[string, string]> = [
        [PROMPT_MD.replace("{{ audience }}", "{{ crowd }}"), "PROMPT.md body uses {{crowd}}, which is not declared in 'inputs'"],
        [PROMPT_MD.replace("aimed at {{ audience }}", "aimed at everyone"), "PROMPT.md declares input 'audience', which the body never uses as {{audience}}"],
      ];
      for (const [content, reason] of cases) {
        writeFileSync(join("p", "PROMPT.md"), content);
        for (const run of [
          () => dispatchSkill(["publish", "alice/landing@1.0.0", "--path", "p", "--name", "Landing"]),
          () => dispatchPrompt(["publish", "alice/landing@1.0.0", "--path", "p", "--name", "Landing"]),
        ]) {
          const error = await rejection(run());
          expect(error).toBeInstanceOf(UsageError);
          expect(error.message).toBe(`${reason}. Fix ${join("p", "PROMPT.md")} and publish again.`);
        }
      }
      expect(calls).toEqual([]);
    });
  });
});
