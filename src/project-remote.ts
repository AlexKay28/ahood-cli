// Git remotes for project guides (ahood-cli#185): reading this repository's
// origin, and normalizing a remote to the `host/owner/repo` form the ahood
// server stores and matches on. normalizeProjectRemote is a line-for-line port
// of the server's lib/projects/normalize-project-remote.ts (ahood#778) -- the
// two must agree, or `project init` writes a remote the lookup never matches.
// tests/project-remote.test.ts runs the server's own test table against it.
import { execFileSync } from "node:child_process";

export type NormalizeProjectRemoteResult = { ok: true; value: string } | { ok: false; reason: string };

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_SEGMENT = /^[a-z0-9._-]+$/;
const ALLOWED_SCHEMES = ["https", "http", "ssh", "git"];
const MAX_PROJECT_REMOTE_LENGTH = 255;
const MAX_PATH_SEGMENTS = 8;

// Never echoes the input back: a rejected remote can still carry a
// credential (`https://user:token@...`).
const INVALID: NormalizeProjectRemoteResult = {
  ok: false,
  reason: "not a git remote; expected host/owner/repo, e.g. github.com/owner/repo",
};

// Strips the scheme, any userinfo (`user:token@`), the port, a trailing
// `.git` and trailing slashes, then lowercases everything.
export function normalizeProjectRemote(raw: string): NormalizeProjectRemoteResult {
  const input = raw.trim();
  if (!input || input.length > MAX_PROJECT_REMOTE_LENGTH) return INVALID;
  if (/[\s?#\\]/.test(input)) return INVALID;

  let rest: string;
  const scheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (!ALLOWED_SCHEMES.includes(scheme[1].toLowerCase())) return INVALID;
    rest = input.slice(scheme[0].length);
  } else {
    // scp-like form: [user@]host:path, where the path does not start with "/".
    const scp = input.match(/^(?:[^@/:]+@)?([^@/:]+):(?!\/)(.+)$/);
    rest = scp ? `${scp[1]}/${scp[2]}` : input;
  }

  const slash = rest.indexOf("/");
  if (slash <= 0) return INVALID;
  let host = rest.slice(0, slash);
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  host = host.replace(/:\d+$/, "").toLowerCase();
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return INVALID;

  const path = rest
    .slice(slash + 1)
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const segments = path.split("/");
  if (segments.length < 2 || segments.length > MAX_PATH_SEGMENTS) return INVALID;
  if (!segments.every((s) => s !== "." && s !== ".." && PATH_SEGMENT.test(s))) return INVALID;

  return { ok: true, value: `${host}/${segments.join("/")}` };
}

// The current repository's origin, normalized, or undefined when there is no
// git, no repository, no origin, or an origin that is not a shareable remote.
// The raw URL never leaves this function: it can carry a token.
export function detectProjectRemote(): string | undefined {
  let raw: string;
  try {
    raw = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return undefined;
  }
  const normalized = normalizeProjectRemote(raw);
  return normalized.ok ? normalized.value : undefined;
}
