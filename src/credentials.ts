import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Credentials = { token: string };

function credentialsPath(): string {
  return join(homedir(), ".config", "skillhub", "credentials.json");
}

export function readCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  const path = credentialsPath();
  const dir = join(homedir(), ".config", "skillhub");
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

// SKILLHUB_TOKEN always wins -- this is what lets CI use a token without
// ever running the interactive device-code `login` flow.
export function resolveToken(): string | null {
  if (process.env.SKILLHUB_TOKEN) return process.env.SKILLHUB_TOKEN;
  return readCredentials()?.token ?? null;
}
