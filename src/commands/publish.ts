import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pack } from "tar-stream";
import { createGzip } from "node:zlib";
import { apiJson } from "../http.js";

type InitResponse = { upload_url: string; storage_path: string; version_id: string };

// Matched by ENTRY NAME at every depth, not by path prefix, so a nested
// `vendor/thing/.git` is skipped the same as a top-level one. Not a
// .gitignore parser (out of scope) -- just the fixed set of names that must
// never end up in a published archive:
//   .git      -- .git/config routinely carries a remote URL with embedded
//                credentials (https://user:ghp_xxx@github.com/...), which the
//                server-side secret scanner's regexes (AKIA, PEM headers,
//                32+ hex) do not match.
//   node_modules -- never part of a skill, and megabytes of it.
//   .env / .env.* -- the single most likely place a real secret lives.
//   .DS_Store -- noise.
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return false;
}

async function tarGzDirectory(dir: string): Promise<Buffer> {
  const { readdirSync, statSync } = await import("node:fs");
  const tar = pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];

  function addDir(current: string, prefix: string) {
    for (const entry of readdirSync(current)) {
      if (isExcluded(entry)) continue;
      const fullPath = join(current, entry);
      const relPath = prefix ? `${prefix}/${entry}` : entry;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        addDir(fullPath, relPath);
      } else {
        tar.entry({ name: relPath, size: stat.size }, readFileSync(fullPath));
      }
    }
  }

  addDir(dir, "");
  tar.finalize();

  return new Promise((resolve, reject) => {
    gzip.on("data", (chunk) => chunks.push(chunk as Buffer));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    tar.pipe(gzip);
  });
}

export async function publish(args: string[]): Promise<void> {
  const path = args[0] ?? ".";
  const skillMdPath = join(path, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    throw new Error(`No SKILL.md found at ${skillMdPath} -- publish must point at a skill folder's root.`);
  }

  // A real ahood CLI would parse owner/slug/version/name out of SKILL.md
  // frontmatter or a companion manifest -- this MVP takes them as explicit
  // flags, matching how `versions/init`'s API itself requires them
  // separately from the archive. Kept simple: --slug, --owner, --version are
  // required; metadata creation (POST /skills) is assumed already done via
  // the web UI or a prior publish -- this command only pushes a NEW VERSION
  // of an existing skill, matching the ADR's "publish tars, calls
  // versions/init -> upload -> versions/complete" description exactly (it
  // does not create the skill's top-level metadata row).
  const ownerIndex = args.indexOf("--owner");
  const slugIndex = args.indexOf("--slug");
  const versionIndex = args.indexOf("--version");
  const owner = ownerIndex >= 0 ? args[ownerIndex + 1] : undefined;
  const slug = slugIndex >= 0 ? args[slugIndex + 1] : undefined;
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  if (!owner || !slug || !version) {
    throw new Error("Usage: ahood publish <path> --owner <owner> --slug <skill> --version <x.y.z>");
  }

  const archive = await tarGzDirectory(path);

  const init = await apiJson<InitResponse>(`/api/v1/skills/${owner}/${slug}/versions/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version, package_size_bytes: archive.length }),
  });

  // TS's lib.dom BodyInit (in scope here since tsconfig has no explicit
  // "lib" override, so DOM is included alongside the Node types) type-checks
  // Buffer/Uint8Array against `Uint8Array<ArrayBuffer>` specifically as of
  // TS 5.7+'s ArrayBufferLike generics, which a Node Buffer's
  // `Uint8Array<ArrayBufferLike>` doesn't structurally satisfy even though
  // it is a valid BufferSource at runtime (this is exactly what Node's own
  // fetch/undici accepts) -- see undici-types' BodyInit, which includes
  // `NodeJS.ArrayBufferView` (i.e. Buffer) directly with no such
  // restriction. Asserting through BodyInit here, rather than reshaping
  // tsconfig's "lib" for the whole package, keeps this fix local to the one
  // call site.
  const putRes = await fetch(init.upload_url, { method: "PUT", body: archive as unknown as BodyInit });
  if (!putRes.ok) throw new Error(`Upload failed with status ${putRes.status}`);

  const complete = await apiJson<{ version: string; status: string }>(
    `/api/v1/skills/${owner}/${slug}/versions/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version_id: init.version_id }),
    },
  );

  console.log(`Published ${owner}/${slug}@${complete.version} (${complete.status})`);
}
