import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_BODY_BYTES,
  fillPrompt,
  missingPromptInputs,
  parsePromptDoc,
  promptPlaceholders,
  substitutePrompt,
} from "../src/prompt-doc.js";

// ahood-cli#206: the PROMPT.md contract, ported verbatim from the server's
// fixture (ahood repo, tests/lib/prompts/prompt-doc.test.ts, AlexKay28/ahood#1007)
// so src/prompt-doc.ts provably agrees with the publish gate, the fill form
// and the get_prompt MCP tool. Change it only together with that file. The
// server's last block (parseArtifactDescription, a server-only reader) is
// not ported.
const FIXTURE = `---
name: brutalist-landing-page
intent: Generate a single-page site in a brutalist style from a product one-liner
inputs:                      # placeholders the body uses; rendered as a form
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

function parsed(content = FIXTURE) {
  const result = parsePromptDoc(content);
  if (!result.ok) throw new Error(result.reason);
  return result.prompt;
}

function reason(content: string): string {
  const result = parsePromptDoc(content);
  if (result.ok) throw new Error("expected a parse failure");
  return result.reason;
}

const doc = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n${body}`;

describe("parsePromptDoc (#1007)", () => {
  it("reads every field of the issue's example", () => {
    expect(parsed()).toEqual({
      name: "brutalist-landing-page",
      intent: "Generate a single-page site in a brutalist style from a product one-liner",
      inputs: [
        { key: "product", label: "What the product is, one sentence", default: null },
        { key: "audience", label: "Who it is for", default: "developers" },
      ],
      worksWith: ["claude-code", "codex", "cursor", "chatgpt"],
      body: "You are designing a landing page for {{product}}, aimed at {{ audience }}.\nKeep {{product}} in the headline.\n",
    });
  });

  it("accepts a prompt with no inputs and no placeholders", () => {
    expect(parsed(doc("name: x\nintent: y", "Do the thing.")).inputs).toEqual([]);
  });

  it("accepts CRLF line endings, a BOM, quoted scalars, block lists and a block-scalar intent", () => {
    const content =
      "﻿" +
      doc(
        `name: "quoted: name"\nintent: >\n  Find and reveal\n  one class of bug\ninputs:\n  - key: lang\n    label: 'Language, e.g. ''Go'''\nworks_with:\n  - claude-code\n  - codex`,
        "Audit this {{lang}} code.",
      ).replace(/\n/g, "\r\n");
    const prompt = parsed(content);
    expect(prompt.name).toBe("quoted: name");
    expect(prompt.intent).toBe("Find and reveal one class of bug");
    expect(prompt.inputs).toEqual([{ key: "lang", label: "Language, e.g. 'Go'", default: null }]);
    expect(prompt.worksWith).toEqual(["claude-code", "codex"]);
  });

  it("defaults an input's label to its key, and treats an empty default as optional", () => {
    const prompt = parsed(doc("name: x\nintent: y\ninputs:\n  - key: tone\n    default: \"\"", "Tone: {{tone}}"));
    expect(prompt.inputs).toEqual([{ key: "tone", label: "tone", default: "" }]);
    expect(missingPromptInputs(prompt.inputs, {})).toEqual([]);
  });

  it("requires name and intent", () => {
    expect(reason(doc("intent: y", "x"))).toBe("PROMPT.md frontmatter is missing the required 'name' field");
    expect(reason(doc("name: x\ndescription: not an intent", "x"))).toBe("PROMPT.md frontmatter is missing the required 'intent' field");
  });

  it("requires a closed frontmatter block", () => {
    expect(reason("---\nname: x\nintent: y\nbody")).toBe("PROMPT.md frontmatter block is not closed with a second --- line");
  });

  it("names an undeclared placeholder, including a malformed key", () => {
    expect(reason(doc("name: x\nintent: y", "Hi {{who}}"))).toBe("PROMPT.md body uses {{who}}, which is not declared in 'inputs'");
    expect(reason(doc("name: x\nintent: y", "Hi {{2nd}}"))).toBe("PROMPT.md body uses {{2nd}}, which is not declared in 'inputs'");
  });

  it("names an input the body never uses", () => {
    expect(reason(doc("name: x\nintent: y\ninputs:\n  - key: who", "Hi"))).toBe(
      "PROMPT.md declares input 'who', which the body never uses as {{who}}",
    );
  });

  it("rejects a duplicate, missing or malformed input key", () => {
    expect(reason(doc("name: x\nintent: y\ninputs:\n  - key: a\n  - key: a", "{{a}}"))).toBe("PROMPT.md declares input 'a' twice");
    expect(reason(doc("name: x\nintent: y\ninputs:\n  - label: no key", "x"))).toBe(
      "PROMPT.md input key '' is not valid (a letter, then letters, digits, _ or -)",
    );
    expect(reason(doc("name: x\nintent: y\ninputs:\n  - key: 9lives", "{{9lives}}"))).toBe(
      "PROMPT.md input key '9lives' is not valid (a letter, then letters, digits, _ or -)",
    );
  });

  it("rejects inputs that are not a list of keyed items", () => {
    expect(reason(doc("name: x\nintent: y\ninputs: product", "{{product}}"))).toBe(
      "PROMPT.md frontmatter field 'inputs' must be a list of items, each with a 'key'",
    );
    expect(reason(doc("name: x\nintent: y\ninputs:\n  - product", "{{product}}"))).toBe(
      "PROMPT.md frontmatter field 'inputs' must be a list of items, each with a 'key'",
    );
  });

  it("caps the body at 32 KB", () => {
    expect(parsePromptDoc(doc("name: x\nintent: y", "a".repeat(MAX_PROMPT_BODY_BYTES))).ok).toBe(true);
    expect(reason(doc("name: x\nintent: y", "a".repeat(MAX_PROMPT_BODY_BYTES + 1)))).toBe("PROMPT.md body exceeds the 32 KB cap");
  });
});

describe("filling a prompt (#1007)", () => {
  it("lists placeholders once each, in first-use order", () => {
    expect(promptPlaceholders(parsed().body)).toEqual(["product", "audience"]);
  });

  it("fills every placeholder, falling back to the default", () => {
    expect(fillPrompt(parsed(), { product: "a CLI for skills" })).toEqual({
      ok: true,
      text: "You are designing a landing page for a CLI for skills, aimed at developers.\nKeep a CLI for skills in the headline.\n",
    });
    expect(fillPrompt(parsed(), { product: "p", audience: "designers" })).toMatchObject({ ok: true, text: expect.stringContaining("aimed at designers.") });
  });

  it("names a missing required input instead of filling", () => {
    expect(fillPrompt(parsed(), {})).toEqual({ ok: false, missing: ["product"] });
    expect(fillPrompt(parsed(), { product: "" })).toEqual({ ok: false, missing: ["product"] });
  });

  it("is one pass: a value containing {{x}} is inserted verbatim", () => {
    const result = fillPrompt(parsed(), { product: "{{audience}}" });
    expect(result.ok && result.text).toContain("landing page for {{audience}}, aimed at developers.");
  });

  it("previews with unfilled required placeholders left as written", () => {
    expect(substitutePrompt(parsed(), {})).toContain("landing page for {{product}}, aimed at developers.");
  });
});
