// ahood#1009: one version tag publishes @ahood/cli and @ahood/opencode-plugin
// at the same version. The plugin's package.json must equal the root's, the
// `npm version` hook keeps them in sync, and the release workflow refuses a
// mismatch and publishes the plugin (idempotently) after the CLI.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-plugin-version.mjs");
const PLUGIN_MANIFEST = join("packages", "opencode-plugin", "package.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
const rootPkg = readJson(join(ROOT, "package.json"));
const pluginPkg = readJson(join(ROOT, PLUGIN_MANIFEST));
const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf-8");

function runCheck(rootDir?: string) {
  return spawnSync(process.execPath, rootDir ? [SCRIPT, rootDir] : [SCRIPT], { encoding: "utf-8" });
}

describe("@ahood/opencode-plugin version", () => {
  it("equals the root package.json version", () => {
    expect(pluginPkg.name).toBe("@ahood/opencode-plugin");
    expect(pluginPkg.version).toBe(rootPkg.version);
  });

  it("scripts/check-plugin-version.mjs passes on this repo", () => {
    const result = runCheck();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("scripts/check-plugin-version.mjs fails (exit 1, names both versions) on a mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahood-plugin-version-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ahood/cli", version: "9.9.9" }));
      mkdirSync(join(dir, "packages", "opencode-plugin"), { recursive: true });
      cpSync(join(ROOT, PLUGIN_MANIFEST), join(dir, PLUGIN_MANIFEST));
      const result = runCheck(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`@ahood/opencode-plugin@${pluginPkg.version}`);
      expect(result.stderr).toContain("@ahood/cli@9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the `npm version` hook syncs the plugin, checks it, and stages its package.json", () => {
    const hook: string = rootPkg.scripts.version;
    const sync = hook.indexOf("node scripts/sync-plugin.mjs");
    const check = hook.indexOf("node scripts/check-plugin-version.mjs");
    const add = hook.indexOf("git add");
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(sync);
    expect(add).toBeGreaterThan(check);
    expect(hook.slice(add)).toContain("packages/opencode-plugin/package.json");
  });
});

describe("release.yml", () => {
  const at = (needle: string) => {
    const i = releaseYml.indexOf(needle);
    expect(i, needle).toBeGreaterThanOrEqual(0);
    return i;
  };

  it("checks the plugin version before the (slow) verify build", () => {
    expect(at("run: node scripts/check-plugin-version.mjs")).toBeLessThan(at("uses: ./.github/actions/verify"));
  });

  it("builds and publishes packages/opencode-plugin after the CLI, idempotently, with the same token", () => {
    const cliPublish = at("run: npm publish\n");
    const build = at("run: npm run build:opencode-plugin");
    const check = at("id: plugin-registry");
    const publish = at("run: npm publish --access public");
    expect(cliPublish).toBeLessThan(build);
    expect(build).toBeLessThan(check);
    expect(check).toBeLessThan(publish);

    const pluginSteps = releaseYml.slice(check);
    expect(pluginSteps).toContain('npm view "${PKG_NAME}@${PKG_VERSION}" version');
    expect(pluginSteps).toContain("if: steps.plugin-registry.outputs.already-published != 'true'");
    expect(pluginSteps.match(/working-directory: packages\/opencode-plugin/g)).toHaveLength(2);
    expect(releaseYml.slice(publish)).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });
});
