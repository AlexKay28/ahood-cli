// ahood#1009: one version tag publishes @ahood/cli and @ahood/opencode-plugin
// at the same version. The plugin's package.json must equal the root's, the
// `npm version` hook keeps them in sync, and the release workflow refuses a
// mismatch and publishes the plugin (idempotently) after the CLI.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-plugin-version.mjs");
const PLUGIN_MANIFEST = join("packages", "opencode-plugin", "package.json");
const CODEX_MANIFEST = join("plugins", "codex", ".codex-plugin", "plugin.json");
const CLAUDE_MANIFEST = join("plugins", "ahood", ".claude-plugin", "plugin.json");
const MARKETPLACE = join(".claude-plugin", "marketplace.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
const rootPkg = readJson(join(ROOT, "package.json"));
const pluginPkg = readJson(join(ROOT, PLUGIN_MANIFEST));
const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf-8");

/** A scratch repo root holding this repo's package.json and every manifest the check reads. */
function copyRepoManifests(dir: string) {
  for (const file of ["package.json", PLUGIN_MANIFEST, CODEX_MANIFEST, CLAUDE_MANIFEST, MARKETPLACE]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
}

function runCheck(rootDir?: string) {
  return spawnSync(process.execPath, rootDir ? [SCRIPT, rootDir] : [SCRIPT], { encoding: "utf-8" });
}

describe("plugin versions (opencode, Codex, Claude Code)", () => {
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
      copyRepoManifests(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ahood/cli", version: "9.9.9" }));
      const result = runCheck(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`@ahood/opencode-plugin@${pluginPkg.version}`);
      expect(result.stderr).toContain("@ahood/cli@9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ahood#1018: the guard covers all three plugins, and the Claude
  // marketplace entry must not carry a second version.
  for (const manifest of [CODEX_MANIFEST, CLAUDE_MANIFEST]) {
    it(`fails when only ${manifest} is behind`, () => {
      const dir = mkdtempSync(join(tmpdir(), "ahood-plugin-version-"));
      try {
        copyRepoManifests(dir);
        const stale = { ...readJson(join(dir, manifest)), version: "0.0.1" };
        writeFileSync(join(dir, manifest), JSON.stringify(stale));
        const result = runCheck(dir);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`ahood@0.0.1 (${manifest})`);
        expect(result.stderr).not.toContain("opencode-plugin");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("fails when the Claude marketplace entry sets a version", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahood-plugin-version-"));
    try {
      copyRepoManifests(dir);
      const marketplace = readJson(join(dir, MARKETPLACE));
      marketplace.plugins[0].version = rootPkg.version;
      writeFileSync(join(dir, MARKETPLACE), JSON.stringify(marketplace));
      const result = runCheck(dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${MARKETPLACE} sets version ${rootPkg.version}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("all three plugin manifests are at the root version, and the marketplace entry sets none", () => {
    for (const manifest of [PLUGIN_MANIFEST, CODEX_MANIFEST, CLAUDE_MANIFEST]) expect(readJson(join(ROOT, manifest)).version, manifest).toBe(rootPkg.version);
    for (const entry of readJson(join(ROOT, MARKETPLACE)).plugins) expect(entry).not.toHaveProperty("version");
  });

  it("the `npm version` hook syncs the plugin, checks it, and stages its package.json", () => {
    const hook: string = rootPkg.scripts.version;
    const sync = hook.indexOf("node scripts/sync-plugin.mjs");
    const check = hook.indexOf("node scripts/check-plugin-version.mjs");
    const add = hook.indexOf("git add");
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(sync);
    expect(add).toBeGreaterThan(check);
    // Every file sync-plugin rewrites on a version bump (the manifests, and
    // the command texts that pin `@ahood/cli@<version>`, ahood#1018), or the
    // tagged commit ships them stale.
    for (const file of [
      "packages/opencode-plugin/package.json",
      "packages/opencode-plugin/src/generated.ts",
      "plugins/codex/.codex-plugin/plugin.json",
      "plugins/codex/skills/ahood/SKILL.md",
      "plugins/ahood/.claude-plugin/plugin.json",
      "plugins/ahood/commands",
    ]) {
      expect(hook.slice(add)).toContain(file);
    }
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
