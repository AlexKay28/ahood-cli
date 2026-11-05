import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Credentials = { token: string };

function credentialsDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ahood");
}

function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

export function readCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { token?: unknown }).token !== "string") {
      return null;
    }
    return parsed as Credentials;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  const path = credentialsPath();
  const dir = credentialsDir();
  // The `mode` option on mkdirSync/writeFileSync only applies when the
  // directory/file is actually created (POSIX O_CREAT semantics) -- if
  // either already exists with looser permissions (manual chmod, a restored
  // backup, etc.), `mode` is silently ignored and the looser bits persist.
  // chmodSync is unconditional, so every write re-asserts 0700/0600
  // regardless of what was there before.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearCredentials(): void {
  const path = credentialsPath();
  if (existsSync(path)) unlinkSync(path);
}

// The env var every ahood config and doc names (ahood#990, decision A).
export const TOKEN_ENV = "AHOOD_TOKEN";

/** Where the token in use came from -- a name only, never the value. */
export type TokenSource = typeof TOKEN_ENV | "credentials";

/**
 * The resolution order, in one place: $AHOOD_TOKEN, then the stored `ahood
 * login` credentials. AHOOD_TOKEN winning is what lets CI use a token without
 * the interactive device-code `login` flow. Truthiness, so an empty variable
 * falls through.
 */
export function resolveTokenWithSource(): { token: string; source: TokenSource } | null {
  const fromEnv = process.env[TOKEN_ENV];
  if (fromEnv) return { token: fromEnv, source: TOKEN_ENV };
  const stored = readCredentials()?.token;
  return stored ? { token: stored, source: "credentials" } : null;
}

export function resolveToken(): string | null {
  return resolveTokenWithSource()?.token ?? null;
}
