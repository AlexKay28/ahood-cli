// PROMPT.md: the root document of the `prompt` artifact kind (ahood-cli#206,
// AlexKay28/ahood#1007). A port of the server's lib/prompts/prompt-doc.ts --
// the one reader the publish gate, the artifact page's fill form and the
// get_prompt MCP tool all run -- so `ahood prompt get` fills a prompt exactly
// as the site does, and `ahood skill publish` / `ahood prompt publish` refuse
// locally what the server would refuse after the upload. Keep the code below the header byte-for-byte in
// step with that file; tests/prompt-doc.test.ts is its fixture, ported as-is.
//
//   ---
//   name: brutalist-landing-page
//   intent: Generate a single-page site in a brutalist style
//   inputs:
//     - key: product
//       label: What the product is, one sentence
//     - key: audience
//       label: Who it is for
//       default: developers
//   works_with: [claude-code, codex, cursor, chatgpt]
//   ---
//   You are designing a landing page for {{product}}, aimed at {{audience}} ...
//
// The contract:
//   - `name` and `intent` are required; `intent` is the prompt's description.
//   - `inputs` is an optional list; each item needs a `key` (a letter, then
//     letters, digits, `_` or `-`), an optional `label` (defaults to the key)
//     and an optional `default`. An input with no `default` is required.
//   - Every `{{key}}` (inner spaces allowed) in the body is a declared input,
//     and every declared input appears in the body at least once.
//   - The body is at most 32 KB.
//   - Filling is one pass: a value that itself contains `{{x}}` is inserted
//     verbatim, never expanded again.
//
// Hand-rolled, not a YAML dependency, for the same reason the server's is: it
// accepts exactly the shapes above -- flat scalars (plain, quoted, or a `|`/`>`
// block), inline `[a, b]` lists, and block lists of scalars or of flat maps.
// Pure (no imports, no I/O).

export const MAX_PROMPT_BODY_BYTES = 32 * 1024;

export type PromptInput = { key: string; label: string; default: string | null };

export type PromptDoc = {
  name: string;
  intent: string;
  inputs: PromptInput[];
  worksWith: string[];
  body: string;
};

export type PromptDocResult = { ok: true; prompt: PromptDoc } | { ok: false; reason: string };

/** What filling needs: the declared inputs and the body. */
export type FillablePrompt = { inputs: readonly PromptInput[]; body: string };

export type PromptFillResult = { ok: true; text: string } | { ok: false; missing: string[] };

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
// `{{ key }}`. The key group is deliberately looser than KEY_PATTERN so a
// malformed key ({{2nd}}) is reported as undeclared instead of slipping
// through as literal text.
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

type YamlValue = string | string[] | Record<string, string>[];

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason: `PROMPT.md ${reason}` };
}

function splitDocument(content: string): { ok: true; lines: string[]; body: string } | { ok: false; reason: string } {
  // A UTF-8 BOM is common in Windows-authored files; see parse-loop-frontmatter.ts.
  if (content.startsWith("\uFEFF")) content = content.slice(1);
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return fail("must start with a YAML frontmatter block delimited by ---");
  }
  const afterOpen = content.slice(content.indexOf("\n") + 1);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(afterOpen);
  if (!close) return fail("frontmatter block is not closed with a second --- line");
  return {
    ok: true,
    lines: afterOpen.slice(0, close.index).split(/\r?\n/),
    body: afterOpen.slice(close.index + close[0].length),
  };
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length;
}

/** A scalar as written after `key:`: quotes removed, a trailing ` # comment`
 *  dropped from an unquoted value. */
function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
}

function parseInlineList(raw: string): string[] | null {
  const value = parseScalar(raw);
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => parseScalar(item))
    .filter((item) => item.length > 0);
}

function splitKeyValue(text: string): [string, string] | null {
  const colon = text.indexOf(":");
  if (colon <= 0) return null;
  return [text.slice(0, colon).trim(), text.slice(colon + 1)];
}

function joinBlock(lines: string[], style: string): string {
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return "";
  const minIndent = Math.min(...nonBlank.map(indentOf));
  const dedented = lines.map((l) => l.slice(minIndent));
  if (style.startsWith("|")) return dedented.join("\n").trim();
  return dedented
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").map((l) => l.trim()).join(" "))
    .join("\n")
    .trim();
}

/** The indented block under a `key:` line: a list of scalars, or a list of
 *  flat maps (`- key: x` followed by more-indented `label: y` lines). */
function parseBlockList(lines: string[], field: string): YamlValue | { error: string } {
  const items: (string | Record<string, string>)[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed === "-") {
      const rest = trimmed.slice(1).trim();
      const pair = splitKeyValue(rest);
      if (pair && !/^["']/.test(rest)) items.push({ [pair[0]]: parseScalar(pair[1]) });
      else items.push(parseScalar(rest));
      continue;
    }
    const last = items[items.length - 1];
    const pair = splitKeyValue(trimmed);
    if (!pair || last === undefined || typeof last === "string") {
      return { error: `frontmatter field '${field}' has a line that is not a list item: ${trimmed}` };
    }
    last[pair[0]] = parseScalar(pair[1]);
  }
  if (items.every((item) => typeof item === "string")) return items as string[];
  if (items.every((item) => typeof item !== "string")) return items as Record<string, string>[];
  return { error: `frontmatter field '${field}' mixes plain items and key: value items` };
}

function parseFrontmatter(lines: string[]): { ok: true; fields: Map<string, YamlValue> } | { ok: false; reason: string } {
  const fields = new Map<string, YamlValue>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    if (indentOf(line) > 0) return fail(`frontmatter has an indented line outside any field: ${line.trim()}`);
    const pair = splitKeyValue(line);
    if (!pair) return fail(`frontmatter line is not 'key: value': ${line.trim()}`);
    const [key, rawValue] = pair;
    // The indented continuation of this field.
    let end = i + 1;
    while (end < lines.length && (lines[end].trim().length === 0 || indentOf(lines[end]) > 0)) end++;
    const nested = lines.slice(i + 1, end);
    const value = parseScalar(rawValue);
    if (/^[|>][-+]?\d*$/.test(value)) {
      fields.set(key, joinBlock(nested, value));
    } else if (value.length === 0) {
      const list = parseBlockList(nested, key);
      if (!Array.isArray(list) && typeof list === "object") return fail(list.error);
      fields.set(key, list);
    } else {
      const inline = parseInlineList(rawValue);
      fields.set(key, inline ?? value);
    }
    i = end;
  }
  return { ok: true, fields };
}

function stringField(fields: Map<string, YamlValue>, key: string): string | null {
  const value = fields.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseInputs(value: YamlValue | undefined): { ok: true; inputs: PromptInput[] } | { ok: false; reason: string } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return { ok: true, inputs: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item === "string")) {
    return fail("frontmatter field 'inputs' must be a list of items, each with a 'key'");
  }
  const inputs: PromptInput[] = [];
  for (const item of value as Record<string, string>[]) {
    const key = item.key ?? "";
    if (!KEY_PATTERN.test(key)) {
      return fail(`input key '${key}' is not valid (a letter, then letters, digits, _ or -)`);
    }
    if (inputs.some((input) => input.key === key)) return fail(`declares input '${key}' twice`);
    inputs.push({ key, label: item.label || key, default: "default" in item ? item.default : null });
  }
  return { ok: true, inputs };
}

/** The distinct `{{key}}` names a body uses, in first-use order. */
export function promptPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

export function parsePromptDoc(content: string): PromptDocResult {
  const doc = splitDocument(content);
  if (!doc.ok) return doc;
  const frontmatter = parseFrontmatter(doc.lines);
  if (!frontmatter.ok) return frontmatter;
  const { fields } = frontmatter;

  const name = stringField(fields, "name");
  if (!name) return fail("frontmatter is missing the required 'name' field");
  const intent = stringField(fields, "intent");
  if (!intent) return fail("frontmatter is missing the required 'intent' field");

  const parsedInputs = parseInputs(fields.get("inputs"));
  if (!parsedInputs.ok) return parsedInputs;
  const { inputs } = parsedInputs;

  const worksWithRaw = fields.get("works_with");
  const worksWith = typeof worksWithRaw === "string" ? [worksWithRaw] : Array.isArray(worksWithRaw) ? worksWithRaw.filter((w): w is string => typeof w === "string") : [];

  const { body } = doc;
  if (new TextEncoder().encode(body).length > MAX_PROMPT_BODY_BYTES) {
    return fail(`body exceeds the ${MAX_PROMPT_BODY_BYTES / 1024} KB cap`);
  }
  const used = promptPlaceholders(body);
  const declared = new Set(inputs.map((input) => input.key));
  const undeclared = used.find((key) => !declared.has(key));
  if (undeclared) return fail(`body uses {{${undeclared}}}, which is not declared in 'inputs'`);
  const unused = inputs.find((input) => !used.includes(input.key));
  if (unused) return fail(`declares input '${unused.key}', which the body never uses as {{${unused.key}}}`);

  return { ok: true, prompt: { name, intent, inputs, worksWith, body } };
}

/** Required inputs (no default) that `values` leaves empty, in declared order. */
export function missingPromptInputs(inputs: readonly PromptInput[], values: Readonly<Record<string, string | undefined>>): string[] {
  return inputs.filter((input) => input.default === null && !values[input.key]).map((input) => input.key);
}

/** The body with every placeholder replaced: the given value, else the
 *  input's default. Fails, naming them, when a required input has neither. */
export function fillPrompt(prompt: FillablePrompt, values: Readonly<Record<string, string | undefined>>): PromptFillResult {
  const missing = missingPromptInputs(prompt.inputs, values);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, text: substitutePrompt(prompt, values) };
}

/** Best-effort substitution for a live preview: an input with no value and
 *  no default stays as its `{{key}}`. Never fails. */
export function substitutePrompt(prompt: FillablePrompt, values: Readonly<Record<string, string | undefined>>): string {
  const byKey = new Map(prompt.inputs.map((input) => [input.key, input]));
  return prompt.body.replace(PLACEHOLDER, (whole, key: string) => {
    const value = values[key];
    if (value) return value;
    return byKey.get(key)?.default ?? whole;
  });
}
