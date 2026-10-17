// Shared fixtures for the kind-scoped registry tests (kinds.test.ts,
// project.test.ts): a tiny archive builder and a fake of the REST surface the
// registry verbs call, recording every request so a test can assert "no side
// effect" as "no non-GET request and no download".
import { vi } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

export const API_URL = "http://ahood.test";

export function tarGz(files: Record<string, string>): Promise<Buffer> {
  const tar = pack();
  for (const [name, content] of Object.entries(files)) tar.entry({ name }, content);
  tar.finalize();
  const chunks: Buffer[] = [];
  return new Promise((resolvePromise, reject) => {
    tar.on("data", (chunk) => chunks.push(chunk as Buffer));
    tar.on("end", () => resolvePromise(gzipSync(Buffer.concat(chunks))));
    tar.on("error", reject);
  });
}

export type Entry = {
  kind: string | undefined; // undefined = the response omits `kind` entirely
  version: string;
  archive: Buffer;
  rootDoc: string;
};

export type Call = { method: string; url: string; body?: string };

export const ROOT_DOCS: Record<string, string> = { skill: "SKILL.md", agent: "AGENT.md", mcp: "server.json", doc: "DOC.md", project: "PROJECT.md" };

export async function entry(kind: string | undefined, version = "1.0.0", contentKind = kind ?? "skill"): Promise<Entry> {
  const rootDoc = ROOT_DOCS[contentKind];
  const content =
    contentKind === "mcp"
      ? JSON.stringify({ name: "srv", description: "d", remotes: [{ url: "https://mcp.example.com/mcp" }] })
      : `---\nname: x\ndescription: d\n---\nbody\n`;
  return { kind, version, archive: await tarGz({ [rootDoc]: content }), rootDoc };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A small fake of the REST surface the registry verbs use. `mine` is what
// GET ?mine=true returns.
export function fakeRegistry(entries: Record<string, Entry>, mine: unknown[] = []) {
  const calls: Call[] = [];
  const created = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init.body === "string" ? init.body : undefined });
      const u = new URL(url);
      if (u.origin === "http://upload.test") return new Response(null, { status: 200 });
      const parts = u.pathname.replace(/^\/api\/v1\/skills\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
      if (parts.length === 0) {
        if (method === "POST") {
          const slug = JSON.parse(init.body as string).slug;
          created.add(`alice/${slug}`);
          return json({ id: "id", slug, owner: "alice" }, 201);
        }
        if (u.searchParams.get("mine") === "true") {
          // Like the registry since ahood#657: ?kind= filters the owner's rows.
          const k = u.searchParams.get("kind");
          return json({ skills: k ? mine.filter((r) => (r as { kind?: string }).kind === k) : mine });
        }
        return json({ skills: [{ slug: "found", name: "Found", tagline: null, downloads_count: 1, profiles: { username: "alice" } }] });
      }
      const key = `${parts[0]}/${parts[1]}`;
      const e = entries[key];
      const rest = parts.slice(2);
      const exists = e !== undefined || created.has(key);
      if (rest[0] === "versions" && rest[1] === "init") {
        return exists ? json({ upload_url: "http://upload.test/put", storage_path: "s", version_id: "v1" }) : json({ error: "Not found" }, 404);
      }
      if (rest[0] === "versions" && rest[1] === "complete") return json({ version_id: "v1", status: "processing" }, 202);
      if (!e && created.has(key) && rest[0] === "versions") return json({ version: rest[1], status: "published" });
      if (!e) return json({ error: "Not found" }, 404);
      const checksum = createHash("sha256").update(e.archive).digest("hex");
      const versionRow = { version: e.version, manifest: [{ path: e.rootDoc }], checksum_sha256: checksum, skill_md_content: "doc", changelog_md: null };
      const kindField = e.kind === undefined ? {} : { kind: e.kind };
      if (rest.length === 0) {
        if (method === "GET") return json({ slug: parts[1], owner: parts[0], name: "N", tags: [], skill_versions: versionRow, ...kindField });
        if (method === "PATCH") return json({ slug: parts[1], tagline: null, license: null, visibility: "public", tags: [] });
        return json({ ok: true });
      }
      if (rest[0] === "download") return new Response(new Uint8Array(e.archive), { status: 200 });
      if (rest[0] === "versions" && rest.length === 1) return json({ versions: [{ version: e.version, created_at: "t", package_size_bytes: 1, changelog_md: null }] });
      if (rest[0] === "versions") {
        if (method === "GET") return json({ ...versionRow, yanked_at: null, status: "published", ...kindField });
        return json({ ok: true });
      }
      if (rest[0] === "star") return json({ starred: method === "POST" });
      if (rest[0] === "share") return json({ shared: method === "POST" });
      return json({ error: `unexpected ${method} ${url}` }, 404);
    }),
  );
  return calls;
}

export function mutations(calls: Call[]): Call[] {
  return calls.filter((c) => c.method !== "GET" || c.url.includes("/download"));
}

// The backend's flat-frontmatter validators (DOC.md, PROJECT.md): a leading
// `---` line, a closing `---` line, and non-empty name and description.
export function backendAcceptsDocMd(content: string): boolean {
  if (!content.startsWith("---\n")) return false;
  const afterOpen = content.slice(4);
  const close = afterOpen.match(/\r?\n---\r?\n/);
  if (!close || close.index === undefined) return false;
  const fields: Record<string, string> = {};
  for (const line of afterOpen.slice(0, close.index).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i !== -1) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Boolean(fields.name) && Boolean(fields.description);
}
