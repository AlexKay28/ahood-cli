// Shared harness for the ahood#979 command tests (status, sync, pin, review):
// a temp project as cwd, a temp HOME, AHOOD_INSTALLED_FILE inside it, and a
// fetch stub for the /api/v1/me/* routes layered over whatever fetch is
// already stubbed (fakeRegistry for the registry routes).
import { vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_URL, json } from "./fake-registry.js";

export type MeCall = { method: string; path: string; body: unknown };

export function setupEnv() {
  const saved = {
    cwd: process.cwd(),
    HOME: process.env.HOME,
    AHOOD_API_URL: process.env.AHOOD_API_URL,
    AHOOD_TOKEN: process.env.AHOOD_TOKEN,
    AHOOD_INSTALLED_FILE: process.env.AHOOD_INSTALLED_FILE,
  };
  const dir = mkdtempSync(join(tmpdir(), "ahood-979-"));
  const project = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(project);
  mkdirSync(home);
  process.chdir(project);
  process.env.HOME = home;
  process.env.AHOOD_API_URL = API_URL;
  process.env.AHOOD_TOKEN = "test-token";
  const installedFile = join(home, ".ahood", "installed.json");
  process.env.AHOOD_INSTALLED_FILE = installedFile;
  process.exitCode = 0;
  return {
    dir,
    project,
    installedFile,
    readInstalledJson: () => JSON.parse(readFileSync(installedFile, "utf-8")),
    restore() {
      vi.unstubAllGlobals();
      process.chdir(saved.cwd);
      rmSync(dir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(saved)) {
        if (k === "cwd") continue;
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.exitCode = 0;
    },
  };
}

type Handler = (call: MeCall) => Response | Promise<Response>;

/** Routes /api/v1/me/* to `handler`; everything else to the fetch already stubbed. */
export function stubMeApi(handler: Handler): MeCall[] {
  const calls: MeCall[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      if (!u.pathname.startsWith("/api/v1/me/")) return inner(input, init);
      const call: MeCall = {
        method: (init.method ?? "GET").toUpperCase(),
        path: u.pathname + u.search,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

/** A /me/status handler that answers every installed item from `latest`
 *  (owner/slug -> {kind, latest, is_owner?, evolution?}); unknown -> not_found. */
export function statusFrom(latest: Record<string, { kind: string; latest: string; is_owner?: boolean; evolution?: unknown }>): Handler {
  return ({ body }) => {
    const installed = (body as { installed: { owner: string; slug: string; version: string }[] }).installed;
    return json({
      items: installed.map((i) => {
        const l = latest[`${i.owner}/${i.slug}`];
        if (!l) return { owner: i.owner, slug: i.slug, installed_version: i.version, status: "not_found" };
        return {
          owner: i.owner,
          slug: i.slug,
          installed_version: i.version,
          status: "ok",
          kind: l.kind,
          latest_version: l.latest,
          update_available: l.latest !== i.version,
          is_owner: l.is_owner ?? false,
          ...(l.is_owner ? { evolution: l.evolution ?? { enabled: false, promotion_mode: "review", probe_mode: "off", pending_proposals: 0 } } : {}),
        };
      }),
      plan: { evolution_available: true, consented: true },
    });
  };
}

export function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  return { out, err, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}
