// A marked block inside a file someone else owns (~/.codex/config.toml,
// ~/.codex/AGENTS.md): everything between our begin and end marker lines is
// ours, everything else is the user's and is never touched (ahood#980).
import { SetupRefusedError } from "./errors.js";

export type BlockMarkers = { begin: string; end: string };

type Located = { start: number; end: number } | null;

function locate(text: string, markers: BlockMarkers, path: string): Located {
  const lines = text.split("\n");
  const begins = lines.flatMap((l, i) => (l.trim() === markers.begin ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === markers.end ? [i] : []));
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new SetupRefusedError(
      `${path} has a damaged ahood block (expected exactly one "${markers.begin}" line followed by one "${markers.end}" line). ` +
        "Fix or delete those lines by hand, then re-run; nothing was changed.",
    );
  }
  return { start: begins[0], end: ends[0] };
}

export function hasBlock(text: string, markers: BlockMarkers, path: string): boolean {
  return locate(text, markers, path) !== null;
}

/** The block's current lines (markers included), or null when absent. */
export function readBlock(text: string, markers: BlockMarkers, path: string): string | null {
  const at = locate(text, markers, path);
  if (!at) return null;
  return text.split("\n").slice(at.start, at.end + 1).join("\n");
}

/** `body` is the block WITHOUT markers; returns the full new file text. */
export function upsertBlock(text: string, body: string, markers: BlockMarkers, path: string): string {
  const block = `${markers.begin}\n${body.replace(/\n+$/, "")}\n${markers.end}`;
  const at = locate(text, markers, path);
  if (at) {
    const lines = text.split("\n");
    return [...lines.slice(0, at.start), block, ...lines.slice(at.end + 1)].join("\n");
  }
  if (text.trim() === "") return `${block}\n`;
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return `${base}\n${block}\n`;
}

/** Removes the block and the one blank separator line upsertBlock added before it. */
export function removeBlock(text: string, markers: BlockMarkers, path: string): string {
  const at = locate(text, markers, path);
  if (!at) return text;
  const lines = text.split("\n");
  let start = at.start;
  if (start > 0 && lines[start - 1].trim() === "") start -= 1;
  let end = at.end + 1;
  // A block at the very top was written as "block\n"; drop one blank after it instead.
  if (start === 0 && end < lines.length && lines[end].trim() === "" && end < lines.length - 1) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}
