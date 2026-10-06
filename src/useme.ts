import { readFileSync } from "node:fs";

// The bundled "use me" self-skill (ahood-cli#172): a SKILL.md that teaches an
// AI agent (or a human) how to use this exact CLI version. It lives in the
// source tree at src/useme/SKILL.md and the build copies it to
// dist/useme/SKILL.md, which package.json#files ("dist") ships in the npm
// tarball -- so the path below resolves next to this module both under
// vitest (src/) and when installed (dist/).
//
// Read as raw bytes and written as raw bytes: `ahood help useme` must print
// the file exactly, with no transcoding, banner, or trailing newline added.
export const USEME_PATH = new URL("./useme/SKILL.md", import.meta.url);

export function readUseme(): Buffer {
  return readFileSync(USEME_PATH);
}
