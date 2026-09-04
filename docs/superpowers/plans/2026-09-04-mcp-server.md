# ahood mcp Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ahood mcp`, a new top-level command that starts a Model Context Protocol (MCP) server over stdio, exposing `skill_search`, `skill_view`, `skill_read`, `skill_versions`, `skill_list`, and `whoami` as MCP tools backed by the same data the CLI's `--json` modes already return.

**Architecture:** `src/commands/mcp.ts` (thin CLI entry) calls `src/mcp/server.ts`'s `startMcpServer()`, which builds an `McpServer`, registers 6 tools from `src/mcp/tools.ts`, and connects a `StdioServerTransport`. Every tool handler is wrapped by `src/mcp/safe-tool.ts`, which catches thrown errors and converts them into a structured `isError` result instead of letting them cross the MCP boundary raw, reusing `exit-code.ts`'s existing error categorization. Each of the 6 wrapped commands gets one small extracted core function (e.g. `searchSkills(query, limit?)`) that does just the data fetch, no console output — the existing CLI handler is refactored to call that same function, so CLI behavior and all existing tests are unchanged.

**Tech Stack:** `@modelcontextprotocol/sdk` (TypeScript MCP SDK, stdio + in-memory transports), `zod` (tool input schemas), vitest (existing test runner).

**Spec:** `docs/superpowers/specs/2026-09-04-mcp-server-design.md`

## Global Constraints

- Node >=18 (existing `package.json` engine floor; matches the SDK's own floor).
- New runtime dependencies: `@modelcontextprotocol/sdk`, `zod` — installed via `npm install`, not hand-typed into `package.json`.
- MCP's stdio transport reserves **stdout** exclusively for JSON-RPC frames. `console.log` must never appear in any function an MCP tool handler calls directly. `console.warn`/`console.error` write to **stderr** and are unaffected/safe to leave as-is (verified: none of the 6 extracted functions call `console.log`; `read.ts`'s existing yanked-version `console.warn` is stderr and stays untouched).
- v1 tool list is closed: `skill_search`, `skill_view`, `skill_read`, `skill_versions`, `skill_list`, `whoami`. No mutating tools (`skill_add`/`update`/`remove`/`publish`/etc.) — explicitly out of scope per the spec.
- Every extraction must leave existing CLI behavior byte-for-byte unchanged: `tests/search.test.ts`, `tests/view.test.ts`, `tests/read.test.ts`, `tests/versions.test.ts`, `tests/list.test.ts`, `tests/whoami.test.ts` all pass with **zero edits**.
- MCP tool error codes reuse `exit-code.ts`'s existing categorization rather than a new taxonomy: `UsageError`→`usage_error`, `ApiError` 401/403→`auth_error`, `ApiError` 404→`not_found`, `ApiError` 5xx→`network_error`, `ApiError` other 4xx→`usage_error`, `NetworkError`→`network_error`, anything else→`general_error`.
- After any `help.ts` change, run `npm run sync-readme` — CI enforces this via `node scripts/sync-readme.mjs --check`.

---

### Task 1: MCP SDK dependency + error-mapping wrapper

**Files:**
- Modify: `package.json` (via `npm install`, not hand-edited)
- Create: `src/mcp/safe-tool.ts`
- Test: `tests/mcp-safe-tool.test.ts`

**Interfaces:**
- Produces: `errorCodeFor(error: unknown): ToolErrorCode` and `safeTool<TInput>(fn: (input: TInput) => Promise<unknown>): (input: TInput) => Promise<CallToolResult>`, both exported from `src/mcp/safe-tool.ts`. Every later task's tool registration wraps its core function with `safeTool(...)`.

- [ ] **Step 1: Install the SDK dependencies**

Run: `npm install @modelcontextprotocol/sdk zod`

This adds both to `"dependencies"` in `package.json` and updates `package-lock.json`. No manual edits.

- [ ] **Step 2: Write `src/mcp/safe-tool.ts`**

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, NetworkError } from "../http.js";
import { UsageError } from "../usage-error.js";

export type ToolErrorCode = "usage_error" | "auth_error" | "not_found" | "network_error" | "general_error";

// Mirrors exit-code.ts's exitCodeFor categorization (ahood-cli#83) -- one
// error taxonomy for both the CLI's exit codes and MCP's error_code field,
// rather than maintaining two.
export function errorCodeFor(error: unknown): ToolErrorCode {
  if (error instanceof UsageError) return "usage_error";
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "auth_error";
    if (error.status === 404) return "not_found";
    if (error.status >= 500) return "network_error";
    return "usage_error";
  }
  if (error instanceof NetworkError) return "network_error";
  return "general_error";
}

// Wraps an MCP tool's data-fetching logic so a thrown error never crosses
// the stdio boundary as a raw exception -- caught here and turned into a
// structured isError result instead. `fn` is the tool's own core function
// (e.g. searchSkills), already adapted to take the single zod-validated
// input object each MCP tool callback receives.
export function safeTool<TInput>(
  fn: (input: TInput) => Promise<unknown>,
): (input: TInput) => Promise<CallToolResult> {
  return async (input: TInput) => {
    try {
      const result = await fn(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const body = { error: message, error_code: errorCodeFor(error) };
      return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
    }
  };
}
```

- [ ] **Step 3: Write `tests/mcp-safe-tool.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { safeTool, errorCodeFor } from "../src/mcp/safe-tool.js";
import { ApiError, NetworkError } from "../src/http.js";
import { UsageError } from "../src/usage-error.js";

describe("errorCodeFor", () => {
  it("maps UsageError to usage_error", () => {
    expect(errorCodeFor(new UsageError("bad input"))).toBe("usage_error");
  });

  it("maps ApiError 401/403 to auth_error", () => {
    expect(errorCodeFor(new ApiError(401, "unauthorized"))).toBe("auth_error");
    expect(errorCodeFor(new ApiError(403, "forbidden"))).toBe("auth_error");
  });

  it("maps ApiError 404 to not_found", () => {
    expect(errorCodeFor(new ApiError(404, "not found"))).toBe("not_found");
  });

  it("maps ApiError 5xx to network_error", () => {
    expect(errorCodeFor(new ApiError(500, "internal error"))).toBe("network_error");
  });

  it("maps other ApiError statuses to usage_error", () => {
    expect(errorCodeFor(new ApiError(400, "bad request"))).toBe("usage_error");
  });

  it("maps NetworkError to network_error", () => {
    expect(errorCodeFor(new NetworkError("fetch failed"))).toBe("network_error");
  });

  it("maps anything else to general_error", () => {
    expect(errorCodeFor(new Error("boom"))).toBe("general_error");
  });
});

describe("safeTool", () => {
  it("returns the function's result as JSON text content on success", async () => {
    const wrapped = safeTool(async (input: { n: number }) => ({ doubled: input.n * 2 }));

    const result = await wrapped({ n: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ doubled: 6 }) }]);
  });

  it("catches a thrown error and returns an isError result with error and error_code", async () => {
    const wrapped = safeTool(async () => {
      throw new UsageError("Usage: ahood skill search <query>");
    });

    const result = await wrapped({});

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { type: "text"; text: string }).text);
    expect(body).toEqual({ error: "Usage: ahood skill search <query>", error_code: "usage_error" });
  });
});
```

- [ ] **Step 4: Run the new test**

Run: `npx vitest run tests/mcp-safe-tool.test.ts`
Expected: all 9 tests PASS.

- [ ] **Step 5: Verify the build still compiles**

Run: `npm run build`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/mcp/safe-tool.ts tests/mcp-safe-tool.test.ts
git commit -m "feat(mcp): add MCP SDK dependency and error-mapping tool wrapper"
```

---

### Task 2: Extract `searchSkills` from `search.ts`

**Files:**
- Modify: `src/commands/search.ts`
- Test: `tests/search.test.ts` (must pass unchanged, zero edits)

**Interfaces:**
- Consumes: `apiJson` from `../http.js` (already imported).
- Produces: `export async function searchSkills(query: string, limit?: number): Promise<SearchResult["skills"]>` — consumed by Task 8's `src/mcp/tools.ts`.

- [ ] **Step 1: Replace `src/commands/search.ts` with the extracted version**

Full new file content:

```ts
import { apiJson } from "../http.js";
import { flagValue } from "../flags.js";
import { UsageError } from "../usage-error.js";

type SearchResult = { skills: Array<{ slug: string; name: string; tagline: string | null; downloads_count: number; profiles: { username: string } }> };

const USAGE = "Usage: ahood skill search <query> [--json] [--limit <n>]";

export async function searchSkills(query: string, limit?: number): Promise<SearchResult["skills"]> {
  const qs = new URLSearchParams({ q: query });
  if (limit !== undefined) qs.set("per_page", String(limit));
  const { skills } = await apiJson<SearchResult>(`/api/v1/skills?${qs}`);
  return skills;
}

export async function search(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const limitStr = flagValue(args, "--limit");
  const queryParts = args.filter((a, i) => a !== "--json" && a !== "--limit" && args[i - 1] !== "--limit");
  const unknownFlag = queryParts.find((a) => a.startsWith("--"));
  if (unknownFlag) throw new UsageError(`Unknown flag: ${unknownFlag}\n${USAGE}`);
  const query = queryParts.join(" ");
  if (!query) throw new UsageError(USAGE);
  if (limitStr !== undefined && (!/^\d+$/.test(limitStr) || Number(limitStr) < 1)) {
    throw new UsageError(`--limit must be a positive integer (got "${limitStr}").\n${USAGE}`);
  }
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;

  const skills = await searchSkills(query, limit);

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.profiles.username}/${skill.slug} - ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads)`);
  }
  if (limit !== undefined && skills.length >= limit) {
    console.log(`(showing up to ${limit} results -- pass a higher --limit for more)`);
  }
}
```

- [ ] **Step 2: Run the existing test file to confirm zero behavior change**

Run: `npx vitest run tests/search.test.ts`
Expected: all tests PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/commands/search.ts
git commit -m "refactor(search): extract searchSkills core function for MCP reuse"
```

---

### Task 3: Extract `viewSkill` from `view.ts`

**Files:**
- Modify: `src/commands/view.ts`
- Test: `tests/view.test.ts` (must pass unchanged, zero edits)

**Interfaces:**
- Produces: `export async function viewSkill(owner: string, skill: string): Promise<SkillDetail>` — consumed by Task 8.

- [ ] **Step 1: Replace `src/commands/view.ts` with the extracted version**

```ts
import { spawn } from "node:child_process";
import { apiJson } from "../http.js";
import { getApiUrl } from "../config.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill view <owner>/<skill> [--json] [--web]";

// Matches GET /api/v1/skills/{owner}/{skill}'s actual response shape
// (app/api/v1/skills/[owner]/[skill]/route.ts): visibility is always
// present (resolveSkillByOwnerSlug's base column set), the rest is the
// route's explicit selectColumns list plus the owner/is_starred fields it
// adds after the query.
type SkillDetail = {
  slug: string;
  name: string;
  tagline: string | null;
  license: string | null;
  visibility: string;
  tags: string[];
  homepage: string | null;
  repository: string | null;
  downloads_count: number;
  stars_count: number;
  created_at: string;
  updated_at: string;
  owner: string;
  is_starred: boolean | null;
  skill_versions: {
    version: string;
    checksum_sha256: string;
    yanked_at?: string | null;
    yanked_reason?: string | null;
  } | null;
};

// Spawned with argv as an array (not a shell string), so a crafted owner/skill
// can never inject shell syntax -- and both segments are already restricted
// to a safe charset by parseOwnerSkill before this ever runs.
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    console.log(`Open this URL in your browser: ${url}`);
  }
}

export async function viewSkill(owner: string, skill: string): Promise<SkillDetail> {
  return apiJson<SkillDetail>(`/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`);
}

export async function view(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const web = args.includes("--web");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const url = `${getApiUrl()}/${owner}/${skill}`;
  if (web) {
    openBrowser(url);
    return;
  }

  const detail = await viewSkill(owner, skill);

  if (jsonOutput) {
    console.log(JSON.stringify(detail));
    return;
  }

  const field = (label: string, value: string) => console.log(`  ${label.padEnd(13)}${value}`);
  console.log(`${detail.owner}/${detail.slug}`);
  // Mirrors the wording/tone of `ahood skill add`'s yanked warning (src/commands/add.ts)
  // and the website's skill detail page banner -- this is the one CLI surface
  // whose entire job is "let me check this out before deciding to install it",
  // so it must not be the one place that stays silent about a yanked version.
  if (detail.skill_versions?.yanked_at) {
    console.warn(
      `WARNING: ${detail.owner}/${detail.slug}@${detail.skill_versions.version} has been yanked${detail.skill_versions.yanked_reason ? `: ${detail.skill_versions.yanked_reason}` : "."}`,
    );
  }
  field("name:", detail.name);
  if (detail.tagline) field("tagline:", detail.tagline);
  field("tags:", detail.tags.length > 0 ? detail.tags.join(", ") : "-");
  field("license:", detail.license ?? "-");
  field("visibility:", detail.visibility);
  field("homepage:", detail.homepage ?? "-");
  field("repository:", detail.repository ?? "-");
  field("version:", detail.skill_versions ? detail.skill_versions.version : "no published version");
  field("downloads:", String(detail.downloads_count));
  field("stars:", String(detail.stars_count));
  field("created:", detail.created_at);
  field("updated:", detail.updated_at);
  if (detail.is_starred !== null) field("starred:", detail.is_starred ? "yes" : "no");
  console.log(url);
}
```

- [ ] **Step 2: Run the existing test file to confirm zero behavior change**

Run: `npx vitest run tests/view.test.ts`
Expected: all tests PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/commands/view.ts
git commit -m "refactor(view): extract viewSkill core function for MCP reuse"
```

---

### Task 4: Extract `readSkillMd` from `read.ts`

**Files:**
- Modify: `src/commands/read.ts`
- Test: `tests/read.test.ts` (must pass unchanged, zero edits)

**Interfaces:**
- Produces: `export async function readSkillMd(owner: string, skill: string): Promise<{version: string; content: string}>` — consumed by Task 8. Throws a plain `Error` (not `UsageError`/`ApiError`) for "no published version" / "no SKILL.md content available", same as today — these map to `general_error` via `safeTool`.

- [ ] **Step 1: Replace `src/commands/read.ts` with the extracted version**

```ts
import { apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill read <owner>/<skill> [--json]";

// Matches GET /api/v1/skills/{owner}/{skill}'s actual response shape -- same
// endpoint view.ts calls (see view.ts's SkillDetail for the full field list
// and its provenance comment). Only the fields this command actually uses
// are declared here; skill_md_content is already selected server-side
// (app/api/v1/skills/[owner]/[skill]/route.ts's skill_versions join), it
// just wasn't typed/used by any command until now (ahood-cli#78).
type SkillReadDetail = {
  owner: string;
  slug: string;
  skill_versions: {
    version: string;
    skill_md_content: string | null;
    yanked_at?: string | null;
    yanked_reason?: string | null;
  } | null;
};

export async function readSkillMd(owner: string, skill: string): Promise<{ version: string; content: string }> {
  const detail = await apiJson<SkillReadDetail>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}`,
  );

  if (!detail.skill_versions) {
    throw new Error(`${owner}/${skill} has no published version.`);
  }

  // Mirrors view.ts's exact wording/tone for the same warning -- this
  // command reads straight from the same endpoint/version, so it must not
  // be silent about handing back a yanked version's content. Written to
  // stderr, not stdout -- safe for MCP callers too (only stdout is reserved
  // for the JSON-RPC stream).
  if (detail.skill_versions.yanked_at) {
    console.warn(
      `WARNING: ${detail.owner}/${detail.slug}@${detail.skill_versions.version} has been yanked${detail.skill_versions.yanked_reason ? `: ${detail.skill_versions.yanked_reason}` : "."}`,
    );
  }

  const content = detail.skill_versions.skill_md_content;
  if (!content) {
    throw new Error(`${owner}/${skill}@${detail.skill_versions.version} has no SKILL.md content available.`);
  }

  return { version: detail.skill_versions.version, content };
}

export async function read(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const { version, content } = await readSkillMd(owner, skill);

  if (jsonOutput) {
    console.log(JSON.stringify({ version, content }));
    return;
  }

  // Plain mode prints the raw content verbatim -- no formatting/labels/
  // trailing decoration -- since the whole point is fast/pipeable access to
  // the exact prompt text (e.g. piping into a file or another tool).
  console.log(content);
}
```

- [ ] **Step 2: Run the existing test file to confirm zero behavior change**

Run: `npx vitest run tests/read.test.ts`
Expected: all tests PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/commands/read.ts
git commit -m "refactor(read): extract readSkillMd core function for MCP reuse"
```

---

### Task 5: Extract `listSkillVersions` from `versions.ts`

**Files:**
- Modify: `src/commands/versions.ts`
- Test: `tests/versions.test.ts` (must pass unchanged, zero edits)

**Interfaces:**
- Produces: `export async function listSkillVersions(owner: string, skill: string): Promise<SkillVersion[]>` — consumed by Task 8.

- [ ] **Step 1: Replace `src/commands/versions.ts` with the extracted version**

```ts
import { apiJson } from "../http.js";
import { parseOwnerSkill } from "../spec.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill versions <owner>/<skill> [--json]";

// Matches GET /api/v1/skills/{owner}/{skill}/versions's response shape
// (app/api/v1/skills/[owner]/[skill]/versions/route.ts) -- the same
// select() list backing the MCP list_skill_versions tool. The route filters
// to status "published" and orders most-recent first server-side, so this
// command doesn't re-sort or re-filter.
//
// yanked_at/yanked_reason (ahood-cli#58) are optional/nullable: an older API
// response predating that select() addition simply omits them, which must
// degrade to "not yanked" rather than a runtime crash -- same convention as
// add.ts's VersionMeta.changelog_md.
type SkillVersion = {
  version: string;
  changelog_md: string | null;
  package_size_bytes: number;
  status: string;
  created_at: string;
  yanked_at?: string | null;
  yanked_reason?: string | null;
};

type VersionsResponse = { versions: SkillVersion[] };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export async function listSkillVersions(owner: string, skill: string): Promise<SkillVersion[]> {
  const { versions } = await apiJson<VersionsResponse>(
    `/api/v1/skills/${encodeURIComponent(owner)}/${encodeURIComponent(skill)}/versions`,
  );
  return versions;
}

export async function versions(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json");
  const spec = args.find((a) => !a.startsWith("--"));
  if (!spec) throw new UsageError(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);

  const list = await listSkillVersions(owner, skill);

  if (jsonOutput) {
    console.log(JSON.stringify(list));
    return;
  }

  if (list.length === 0) {
    console.log(`${owner}/${skill} has no published versions.`);
    return;
  }

  console.log(`${owner}/${skill} -- ${list.length} published version${list.length === 1 ? "" : "s"}`);
  const field = (label: string, value: string) => console.log(`  ${label.padEnd(13)}${value}`);
  for (const v of list) {
    console.log("");
    console.log(v.version);
    field("published:", v.created_at);
    field("size:", formatSize(v.package_size_bytes));
    field("changelog:", v.changelog_md ? v.changelog_md : "-");
    // Marked right after the version's other details, only when the API
    // actually flags it (issue #58) -- non-yanked versions print exactly as
    // before, no "status:" line at all.
    if (v.yanked_at) {
      field("status:", v.yanked_reason ? `YANKED -- ${v.yanked_reason}` : "YANKED");
    }
  }
}
```

- [ ] **Step 2: Run the existing test file to confirm zero behavior change**

Run: `npx vitest run tests/versions.test.ts`
Expected: all tests PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/commands/versions.ts
git commit -m "refactor(versions): extract listSkillVersions core function for MCP reuse"
```

---

### Task 6: Extract `listOwnSkills` from `list.ts`

**Files:**
- Modify: `src/commands/list.ts`
- Test: `tests/list.test.ts` (must pass unchanged, zero edits)

**Interfaces:**
- Produces: `export async function listOwnSkills(): Promise<OwnSkill[]>` — consumed by Task 8.

- [ ] **Step 1: Replace `src/commands/list.ts` with the extracted version**

```ts
import { apiJson } from "../http.js";

// Same underlying endpoint as search.ts (GET /api/v1/skills, here with
// ?mine=true instead of ?q=), so it carries the same `profiles.username`
// join -- printing owner/slug (not just the bare slug) is what makes this
// output directly reusable by add/edit/star/remove/unpublish, which all
// require the full "<owner>/<skill>" form.
//
// Always lists the caller's own skills (public and private) -- this is
// "ahood skill list", the entity-scoped rename of the old flat "ahood
// list-mine". No owner argument or other filtering; that's out of scope
// for the rename.
type OwnSkill = {
  slug: string;
  name: string;
  tagline: string | null;
  visibility: string;
  downloads_count: number;
  stars_count: number;
  profiles: { username: string };
};

export async function listOwnSkills(): Promise<OwnSkill[]> {
  const { skills } = await apiJson<{ skills: OwnSkill[] }>("/api/v1/skills?mine=true");
  return skills;
}

export async function listSkills(args: string[] = []): Promise<void> {
  const jsonOutput = args.includes("--json");
  const skills = await listOwnSkills();

  if (jsonOutput) {
    console.log(JSON.stringify(skills));
    return;
  }
  if (skills.length === 0) {
    console.log("You haven't published any skills yet.");
    return;
  }
  for (const skill of skills) {
    console.log(`${skill.profiles.username}/${skill.slug} (${skill.visibility}) - ${skill.name}${skill.tagline ? `: ${skill.tagline}` : ""} (${skill.downloads_count} downloads, ${skill.stars_count} stars)`);
  }
}
```

- [ ] **Step 2: Run the existing test file to confirm zero behavior change**

Run: `npx vitest run tests/list.test.ts`
Expected: all tests PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/commands/list.ts
git commit -m "refactor(list): extract listOwnSkills core function for MCP reuse"
```

---

### Task 7: Extract `checkAuth` from `whoami.ts`

This is the one non-mechanical extraction: `whoami`'s three outcome branches (not-logged-in, authenticated, invalid-token, unknown-error) currently interleave console output/exit-code-setting with the auth-check logic itself. `checkAuth()` becomes a pure function returning a discriminated union describing the outcome, with zero console calls and zero `process.exitCode` mutation; `whoami()` becomes purely a presentation layer over it. Every branch's exact console output and exit code must stay identical — `tests/whoami.test.ts` is the guardrail.

**Files:**
- Modify: `src/commands/whoami.ts`
- Test: `tests/whoami.test.ts` (must pass unchanged, zero edits)

**Interfaces:**
- Produces:
  ```ts
  export type WhoamiResult =
    | { authenticated: false; reason: "not_logged_in" }
    | { authenticated: false; reason: "invalid_token" }
    | { authenticated: true; mode: "session" | "token"; profile?: Profile }
    | { authenticated: null; error: string };
  export async function checkAuth(): Promise<WhoamiResult>
  ```
  consumed by Task 8. Never throws.

- [ ] **Step 1: Replace `src/commands/whoami.ts` with the extracted version**

```ts
import { ApiError, apiJson } from "../http.js";
import { resolveToken } from "../credentials.js";

// Mirrors GET /api/v1/profile's response shape. All fields besides
// `username` are nullable in the backend (a profile can be created before
// any of the optional fields are filled in), so they're typed as such here
// too rather than assumed present.
type Profile = {
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  github_username: string | null;
};

export type WhoamiResult =
  | { authenticated: false; reason: "not_logged_in" }
  | { authenticated: false; reason: "invalid_token" }
  | { authenticated: true; mode: "session" | "token"; profile?: Profile }
  | { authenticated: null; error: string };

// Best-effort enrichment: whoami's real job is answering "does this token
// still authenticate?", which is already settled by the time this runs.
// A failure here (network blip, an otherwise-valid token hitting a 500 on
// this specific route, etc.) must never turn a successful auth check into a
// command failure -- so every error is swallowed and callers fall back to
// the plain "Authenticated..." message instead.
async function fetchProfile(): Promise<Profile | undefined> {
  try {
    return await apiJson<Profile>("/api/v1/profile");
  } catch {
    return undefined;
  }
}

// Pure auth-status check: no console output, no process.exitCode -- callers
// (the CLI's whoami() below, and the MCP whoami tool) decide how to present
// each outcome. Never throws; every failure mode is a normal return value.
export async function checkAuth(): Promise<WhoamiResult> {
  const token = resolveToken();
  if (!token) {
    return { authenticated: false, reason: "not_logged_in" };
  }

  // There is no endpoint that returns an identity for a bearer caller yet, so
  // this can only answer "does this token still authenticate?". It probes
  // /api/v1/auth/tokens, which is deliberately session-only (Task 3), and
  // reads the STATUS to tell the two failure modes apart -- swallowing every
  // error and reporting success unconditionally (as this used to) meant a
  // revoked token and a garbage token both reported success.
  //   403 -> resolveCaller accepted the token, the route then rejected it for
  //          being a token rather than a session. The token is valid.
  //   401 -> resolveCaller could not resolve the token at all: unknown,
  //          revoked, or expired.
  //   anything else (network failure, 5xx, timeout) is NOT the same as an
  //          invalid token, and is reported as its own distinct failure.
  try {
    await apiJson<{ tokens: unknown[] }>("/api/v1/auth/tokens");
    // A session-backed caller (only reachable if this ever runs against a
    // cookie-bearing client) -- the token list came back.
    const profile = await fetchProfile();
    return { authenticated: true, mode: "session", profile };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      const profile = await fetchProfile();
      return { authenticated: true, mode: "token", profile };
    }
    if (error instanceof ApiError && error.status === 401) {
      return { authenticated: false, reason: "invalid_token" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { authenticated: null, error: message };
  }
}

export async function whoami(args: string[] = []): Promise<void> {
  const wantsJson = args.includes("--json");
  const result = await checkAuth();

  if (!result.authenticated && result.reason === "not_logged_in") {
    // Previously exited 0 here, defeating whoami's purpose as a scriptable
    // auth check -- "no token configured at all" must fail just like "token
    // rejected by the server" does below. Exit 4 ("authentication required
    // or rejected"), not the generic 1 -- this is exactly the case the
    // README's own exit-code table names as the canonical example of 4
    // (ahood-cli#80).
    if (wantsJson) console.log(JSON.stringify({ authenticated: false }));
    else console.error("Not logged in. Run `ahood login` (or set AHOOD_TOKEN).");
    process.exitCode = 4;
    return;
  }

  if (!result.authenticated && result.reason === "invalid_token") {
    // Same exit-4 reasoning as the "no token at all" branch above: the
    // token was rejected by the server, which is the other half of the
    // README's exit-code-4 definition ("or the token was refused").
    if (wantsJson) console.log(JSON.stringify({ authenticated: false, reason: "invalid_token" }));
    else console.error("Not authenticated -- your token is invalid or has been revoked.");
    process.exitCode = 4;
    return;
  }

  if (result.authenticated === null) {
    if (wantsJson) console.log(JSON.stringify({ authenticated: null, error: result.error }));
    else console.error(`Could not verify your token: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  if (wantsJson) {
    console.log(JSON.stringify({ authenticated: true, mode: result.mode, ...result.profile }));
    return;
  }
  if (result.mode === "session") {
    console.log(result.profile ? `Authenticated as ${result.profile.username}.` : "Authenticated.");
  } else {
    console.log(
      result.profile
        ? `Authenticated as ${result.profile.username} (personal API token).`
        : "Authenticated with a personal API token.",
    );
  }
}
```

- [ ] **Step 2: Run the existing test file to confirm zero behavior change**

Run: `npx vitest run tests/whoami.test.ts`
Expected: all tests PASS, unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/commands/whoami.ts
git commit -m "refactor(whoami): extract checkAuth core function for MCP reuse"
```

---

### Task 8: Build and test the MCP server

**Files:**
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/server.ts`
- Create: `src/commands/mcp.ts`
- Modify: `src/index.ts`
- Test: `tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: `searchSkills` (Task 2), `viewSkill` (Task 3), `readSkillMd` (Task 4), `listSkillVersions` (Task 5), `listOwnSkills` (Task 6), `checkAuth` (Task 7), `safeTool` (Task 1), `CLI_VERSION` from `../version.js`.
- Produces: `registerTools(server: McpServer): void` (`src/mcp/tools.ts`), `buildServer(): McpServer` and `startMcpServer(): Promise<void>` (`src/mcp/server.ts`), `mcp(args: string[]): Promise<void>` (`src/commands/mcp.ts`) — consumed by Task 9 (docs) and by `index.ts`'s `COMMANDS` map (this task).

- [ ] **Step 1: Write `src/mcp/tools.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "./safe-tool.js";
import { searchSkills } from "../commands/search.js";
import { viewSkill } from "../commands/view.js";
import { readSkillMd } from "../commands/read.js";
import { listSkillVersions } from "../commands/versions.js";
import { listOwnSkills } from "../commands/list.js";
import { checkAuth } from "../commands/whoami.js";

// Registers every v1 MCP tool. Read-only by design (ahood-cli#83's spec) --
// each tool wraps the same core function the equivalent `ahood skill <verb>
// --json` CLI path already calls, so there is exactly one source of truth
// for what each of these returns.
export function registerTools(server: McpServer): void {
  server.registerTool(
    "skill_search",
    {
      description: "Search published skills in the ahood registry.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().optional() },
    },
    safeTool(async ({ query, limit }: { query: string; limit?: number }) => searchSkills(query, limit)),
  );

  server.registerTool(
    "skill_view",
    {
      description: "Show a skill's details (tags, license, homepage, repository, dates, etc.) without installing it.",
      inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    },
    safeTool(async ({ owner, skill }: { owner: string; skill: string }) => viewSkill(owner, skill)),
  );

  server.registerTool(
    "skill_read",
    {
      description: "Read a skill's full SKILL.md content without installing it.",
      inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    },
    safeTool(async ({ owner, skill }: { owner: string; skill: string }) => readSkillMd(owner, skill)),
  );

  server.registerTool(
    "skill_versions",
    {
      description: "List a skill's published-version history (version, changelog, size, publish date).",
      inputSchema: { owner: z.string().min(1), skill: z.string().min(1) },
    },
    safeTool(async ({ owner, skill }: { owner: string; skill: string }) => listSkillVersions(owner, skill)),
  );

  server.registerTool(
    "skill_list",
    {
      description: "List the authenticated caller's own skills, public and private.",
      inputSchema: {},
    },
    safeTool(async () => listOwnSkills()),
  );

  server.registerTool(
    "whoami",
    {
      description: "Report whether the configured token (AHOOD_TOKEN or a stored login) still authenticates.",
      inputSchema: {},
    },
    safeTool(async () => checkAuth()),
  );
}
```

- [ ] **Step 2: Write `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { CLI_VERSION } from "../version.js";

// Split from startMcpServer so tests can build a server and connect it to an
// InMemoryTransport instead of real stdio.
export function buildServer(): McpServer {
  const server = new McpServer({ name: "ahood", version: CLI_VERSION });
  registerTools(server);
  return server;
}

// Connects over stdio and blocks: StdioServerTransport reads process.stdin
// for the life of the process. This is expected -- an MCP host spawns
// `ahood mcp` as a long-lived subprocess and talks to it over stdio for as
// long as the session lasts.
export async function startMcpServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 3: Write `src/commands/mcp.ts`**

```ts
import { startMcpServer } from "../mcp/server.js";

// `ahood mcp` takes no subcommands/flags in v1. Unlike every other
// account-scoped command it never returns until the client disconnects --
// see startMcpServer's comment.
export async function mcp(_args: string[]): Promise<void> {
  await startMcpServer();
}
```

- [ ] **Step 4: Wire `mcp` into `src/index.ts`**

Add the import alongside the other command imports (immediately after the existing `completion` import):

```ts
import { completion } from "./commands/completion.js";
import { mcp } from "./commands/mcp.js";
```

Add `mcp` to the `COMMANDS` map (immediately after `completion,`):

```ts
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: () => login(),
  logout: () => logout(),
  whoami,
  token,
  completion,
  mcp,
  skill: dispatchSkill,
  group: dispatchGroup,
};
```

- [ ] **Step 5: Write `tests/mcp-server.test.ts`**

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server.js";

const API_URL = "http://ahood.test";

type TextContent = { type: "text"; text: string };

function stubApi(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

function stubApiRoutes(routes: Record<string, { status: number; body?: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const route = routes[pathname];
      if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstTextBody(content: unknown): unknown {
  return JSON.parse((content as TextContent[])[0].text);
}

describe("ahood mcp tools", () => {
  const originalApiUrl = process.env.AHOOD_API_URL;
  const originalToken = process.env.AHOOD_TOKEN;

  beforeEach(() => {
    process.env.AHOOD_API_URL = API_URL;
    process.env.AHOOD_TOKEN = "tok_test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalApiUrl === undefined) delete process.env.AHOOD_API_URL;
    else process.env.AHOOD_API_URL = originalApiUrl;
    if (originalToken === undefined) delete process.env.AHOOD_TOKEN;
    else process.env.AHOOD_TOKEN = originalToken;
  });

  it("lists exactly the 6 v1 tools", async () => {
    const client = await connectedClient();

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      ["skill_list", "skill_read", "skill_search", "skill_versions", "skill_view", "whoami"].sort(),
    );
  });

  it("skill_search returns the skills array as tool content", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: null, downloads_count: 3, profiles: { username: "alice" } }];
    stubApi(200, { skills });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_search", arguments: { query: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(skills);
  });

  it("skill_search maps a 404 to a structured isError result with error_code not_found", async () => {
    stubApi(404, { error: "not found" });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_search", arguments: { query: "demo" } });

    expect(result.isError).toBe(true);
    expect((firstTextBody(result.content) as { error_code: string }).error_code).toBe("not_found");
  });

  it("skill_view returns the skill detail object", async () => {
    const detail = { slug: "demo", name: "Demo", owner: "alice", tags: [], downloads_count: 0, stars_count: 0, skill_versions: null };
    stubApi(200, detail);
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_view", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(detail);
  });

  it("skill_read returns version and content", async () => {
    stubApi(200, { owner: "alice", slug: "demo", skill_versions: { version: "1.0.0", skill_md_content: "# Demo" } });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_read", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual({ version: "1.0.0", content: "# Demo" });
  });

  it("skill_read maps 'no published version' to a general_error isError result", async () => {
    stubApi(200, { owner: "alice", slug: "demo", skill_versions: null });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_read", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBe(true);
    const body = firstTextBody(result.content) as { error_code: string; error: string };
    expect(body.error_code).toBe("general_error");
    expect(body.error).toMatch(/no published version/);
  });

  it("skill_versions returns the versions array", async () => {
    const versions = [{ version: "1.0.0", changelog_md: null, package_size_bytes: 100, status: "published", created_at: "2026-01-01" }];
    stubApi(200, { versions });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_versions", arguments: { owner: "alice", skill: "demo" } });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(versions);
  });

  it("skill_list returns the caller's own skills", async () => {
    const skills = [{ slug: "demo", name: "Demo", tagline: null, visibility: "public", downloads_count: 0, stars_count: 0, profiles: { username: "alice" } }];
    stubApi(200, { skills });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_list", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual(skills);
  });

  it("skill_list maps a 401 to an auth_error isError result", async () => {
    stubApi(401, { error: "unauthorized" });
    const client = await connectedClient();

    const result = await client.callTool({ name: "skill_list", arguments: {} });

    expect(result.isError).toBe(true);
    expect((firstTextBody(result.content) as { error_code: string }).error_code).toBe("auth_error");
  });

  it("whoami reports authenticated:false with no token, never as isError", async () => {
    delete process.env.AHOOD_TOKEN;
    const client = await connectedClient();

    const result = await client.callTool({ name: "whoami", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual({ authenticated: false, reason: "not_logged_in" });
  });

  it("whoami reports authenticated:true for a valid session token", async () => {
    stubApiRoutes({ "/api/v1/auth/tokens": { status: 200, body: { tokens: [] } } });
    const client = await connectedClient();

    const result = await client.callTool({ name: "whoami", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(firstTextBody(result.content)).toEqual({ authenticated: true, mode: "session" });
  });
});
```

- [ ] **Step 6: Run the new test file**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: all 11 tests PASS.

- [ ] **Step 7: Run the full test suite and build**

Run: `npm run build && npm test`
Expected: build succeeds; all test files (including every file touched in Tasks 2–7) PASS with zero failures.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts src/commands/mcp.ts src/index.ts tests/mcp-server.test.ts
git commit -m "feat(mcp): register and wire the 6 v1 MCP tools behind 'ahood mcp'"
```

---

### Task 9: Help text, README, and final verification

**Files:**
- Modify: `src/help.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add an `ahood mcp` entry to `TOP_LEVEL_COMMANDS_HELP` in `src/help.ts`**

Insert immediately after the existing `completion` entry (before the closing `];` of `TOP_LEVEL_COMMANDS_HELP`):

```ts
  {
    usage: "ahood mcp",
    summary: "Start an MCP server exposing read-only skill commands as tools over stdio.",
    desc:
      "Start a Model Context Protocol server over stdio, exposing skill_search, skill_view, skill_read, " +
      "skill_versions, skill_list, and whoami as MCP tools -- the same data ahood's --json commands already " +
      "return, reachable as typed tool calls instead of parsed CLI output. Meant to be launched by an " +
      "MCP-aware agent host (e.g. Claude Code's MCP server configuration), not run interactively.",
  },
```

- [ ] **Step 2: Regenerate the README's command table**

Run: `npm run sync-readme`

This adds a `ahood mcp` row to the README's "Account" table automatically from the `help.ts` entry above.

- [ ] **Step 3: Add a short manual note to the README's "Using ahood from an AI agent" section**

In `README.md`, find the bulleted list under `## Using ahood from an AI agent` (it currently ends with the `ahood skill init <name>` bullet, immediately before the `## Development` heading). Add one new bullet at the end of that list:

```markdown
- **A native MCP server, for agents that prefer tool calls to subprocess parsing.** `ahood mcp` starts a Model Context Protocol server over stdio, exposing `skill_search`, `skill_view`, `skill_read`, `skill_versions`, `skill_list`, and `whoami` as typed tools -- the same data the `--json` flags above already return, reachable as structured tool calls instead. Configure your MCP-aware agent host to run `ahood mcp` (or `npx @ahood/cli@latest mcp`) as a stdio server.
```

- [ ] **Step 4: Verify the README sync check passes**

Run: `node scripts/sync-readme.mjs --check`
Expected: `README.md's command table is up to date.`

- [ ] **Step 5: Run the full build and test suite one final time**

Run: `npm run build && npm test`
Expected: build succeeds; every test file passes, including the two new MCP test files and all 6 refactored command test files.

- [ ] **Step 6: Commit**

```bash
git add src/help.ts README.md
git commit -m "docs: document 'ahood mcp' in --help and the README"
```
