import { posix } from "node:path";
import * as tarStream from "tar-stream";
import { sanitizeForTerminal } from "./terminal-safe.js";

// AlexKay28/ahood#792 -- the one archive-entry path rule, mirroring the
// server's lib/publish/entry-path.ts. `SKILL.md` and `././SKILL.md` used to be
// two entries to the server (which reads the FIRST) but one file to
// extractTarGz (resolve() collapsed them and the LAST write won), so a hidden
// later duplicate could overwrite the reviewed file at install. Every
// extractor now refuses such an archive up front instead.

/** True when `path` is already a canonical relative POSIX path: non-empty,
 *  no backslash or NUL, not absolute, no empty / "." / ".." segment, and
 *  unchanged by posix.normalize. */
export function isCanonicalEntryPath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0")) return false;
  if (posix.isAbsolute(path) || posix.normalize(path) !== path) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A tar header name relative to the archive root. `tar -C dir .` names
 *  every entry `./x`, so exactly ONE leading "./" is dropped; whatever
 *  remains must already be canonical (`././x` is rejected, not collapsed). */
export function tarEntryPath(headerName: string): string {
  return headerName.startsWith("./") ? headerName.slice(2) : headerName;
}

/** Walks every header of an already-decompressed tar and throws unless each
 *  non-directory entry has a canonical, unique path. Runs before an extractor
 *  writes or returns anything, so a bad entry anywhere refuses the whole
 *  archive. Directory entries (`./`, `./scripts/`) are not files and are
 *  skipped. */
export async function assertCanonicalEntryPaths(tar: Buffer): Promise<void> {
  const seen = new Set<string>();
  const extract = tarStream.extract();
  await new Promise<void>((resolvePromise, reject) => {
    extract.on("entry", (header, stream, next) => {
      stream.resume();
      if (header.type === "directory") {
        next();
        return;
      }
      const path = tarEntryPath(header.name);
      const problem = !isCanonicalEntryPath(path)
        ? `Refusing to extract unsafe archive entry: ${sanitizeForTerminal(header.name)} (not a canonical relative path)`
        : seen.has(path)
          ? `Refusing to extract archive: it has more than one entry for "${sanitizeForTerminal(path)}"`
          : null;
      if (problem) {
        reject(new Error(problem));
        extract.destroy();
        return;
      }
      seen.add(path);
      next();
    });
    extract.on("finish", () => resolvePromise());
    extract.on("error", reject);
    extract.end(tar);
  });
}
