# MCP Remove/Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "real feature gap" from `ahood`'s issue #169 (follow-ups from #80's MCP server manifest artifacts): `ahood skill remove` doesn't actually delete the corresponding `.mcp.json` entry (it only warns that one still exists), and `ahood skill update` unconditionally skips every mcp-kind entry with "aren't updatable via this command yet" — there is no way to move an installed mcp artifact to a newer published version, or to cleanly uninstall one, via this CLI today.

**Architecture:** A fingerprint mechanism, not a blind sync. `.mcp.json` is a file the CLI shares with the user (and potentially other tools) — unlike a skill's own directory or an agent's own file, nothing else ever touches those. `remove`/`update` must therefore be able to tell "the on-disk entry is still exactly what ahood last wrote" from "something has changed it since" before deleting or overwriting it, mirroring the same "never touch what you don't verifiably own" posture `add.ts`'s `assertNoCollision` already applies to a *fresh* install. A new optional `mcp_config_hash` field on the lockfile's `LockEntry`, stamped by `installMcpEntry`/the new `updateMcpEntry` at write time, is that fingerprint (`sha256` of the exact object written into `mcpServers.<skill>`). `remove`/`update` act (delete/overwrite) only when the on-disk entry's current hash still matches the recorded one; otherwise they refuse and explain why, exactly preserving today's safe (if limited) behavior for an entry with no recorded fingerprint (e.g. one installed before this field existed).

**Tech Stack:** TypeScript, Node's built-in `node:crypto`/`node:fs`, Vitest. No new dependencies.

**Spec:** This plan's spec is `ahood` issue #169's "Real feature gap" section (`https://github.com/AlexKay28/ahood/issues/169`), which explicitly calls for: "teach `remove` to delete the corresponding `mcpServers.<skill>` entry from `.mcp.json` (respecting the same collision-safety posture #80 established — probably still refuse/warn rather than silently touching an entry the user hand-edited), and teach `update` to re-run the install flow for mcp entries (re-resolving secrets, respecting the same collision rules)." Both halves are implemented exactly as scoped there; the issue's other buckets (secret-handling polish, validation/robustness polish, UI/docs polish, test infra) are explicitly out of scope for this plan.

## Global Constraints

- Every existing test in `tests/add.test.ts`, `tests/remove.test.ts`, and `tests/update.test.ts` must keep passing unmodified, with exactly one deliberate exception: `update.test.ts`'s "skips an installed mcp artifact with a clean status message instead of always failing (finding #2)" test, whose fixture is an mcp entry already at latest — under real update support this is now an "already up to date" status (`console.log`), not a "we don't support this yet" warning (`console.warn`); the message moves accordingly, and this plan's Task 3 updates that one test to match, renaming it to reflect what it now actually verifies.
- `mcp_config_hash` is optional (`string | undefined`) on `LockEntry`. An mcp lockfile entry written before this field existed simply lacks it — this is the exact case that must fall back to today's existing safe behavior (`remove`: warn, don't delete; `update`: refuse, don't overwrite), not a case to migrate or backfill.
- Never touch a sibling key in `.mcp.json`'s `mcpServers` object — every read-modify-write in this plan (delete, overwrite) touches exactly the one key for the skill being removed/updated, verified in tests against a fixture with an unrelated second entry present.
- Every `.mcp.json` read-modify-write happens under `withLock` (from `lockfile.ts`), re-reading and re-verifying the fingerprint *inside* the lock rather than trusting an earlier unlocked read — matching `add.ts`'s own existing re-check-under-lock pattern in `installMcpEntry`, since arbitrary time (a download, a secret prompt) may have passed since the pre-check.
- No new dependencies. `hashMcpServerConfig` uses `node:crypto`'s `createHash("sha256")`, already imported in `add.ts`.
- `src/help.ts`'s `desc` field (not `summary` — `summary` alone feeds `README.md`'s generated command table via `scripts/sync-readme.mjs`) gets a short addition documenting the new mcp-aware behavior for both commands. Confirmed during plan authoring that changing only `desc` leaves `README.md` unaffected (`node scripts/sync-readme.mjs --check` still reports "up to date" against an unchanged `summary`), so this plan's Task 4 does not need to touch `README.md` directly.
- This repo's tests require a build first: `npm run build` (`tsc -p tsconfig.json`) before `npm test`/`vitest run` — one existing test (`tests/index.test.ts`) invokes the compiled `dist/index.js` directly and fails with `MODULE_NOT_FOUND` otherwise. Not a regression from this plan; a pre-existing environment-setup step.

---

### Task 1: Shared mcp-config helpers in add.ts, and the fingerprint field

**Files:**
- Modify: `src/lockfile.ts`
- Modify: `src/commands/add.ts`
- Test: Modify `tests/add.test.ts`

**Interfaces:**
- Produces: `LockEntry` gains `mcp_config_hash?: string`. `add.ts` newly exports `readMcpConfig(): Record<string, unknown>` (was module-private), `hashMcpServerConfig(config: unknown): string`, `resolveMcpServerConfig(buffer: Buffer): Promise<{ manifest: ServerManifest; serverConfig: Record<string, unknown> }>`, and `updateMcpEntry(owner: string, skill: string, meta: VersionMeta, currentEntry: LockEntry | undefined): Promise<void>`. Tasks 2 and 3 consume `readMcpConfig`/`hashMcpServerConfig` (remove.ts) and `updateMcpEntry` (update.ts) — do not start those tasks before this one is committed.
- Consumes: nothing new from other tasks (this is the foundation task).

- [ ] **Step 1: Add the fingerprint field to LockEntry**

In `src/lockfile.ts`, replace:

```ts
export type LockEntry = { version: string; checksum_sha256: string };
```

with:

```ts
// mcp_config_hash is only ever set for a kind='mcp' entry (add.ts's
// installMcpEntry) -- a fingerprint of exactly what was written into
// .mcp.json's mcpServers.<skill> entry at install/update time, letting
// remove/update (ahood-cli#169) tell an untouched entry from a hand-edited
// one before deleting or overwriting it. Absent for skill/agent entries,
// and absent for any mcp entry installed before this field existed.
export type LockEntry = { version: string; checksum_sha256: string; mcp_config_hash?: string };
```

- [ ] **Step 2: Export readMcpConfig**

In `src/commands/add.ts`, find:

```ts
// Reads and validates .mcp.json's shape, defaulting to an empty config when
// the file doesn't exist yet. Guards `mcpServers` itself (not just the
// top-level object) against being missing, `null`, or an array: a bare
// `fileContents.mcpServers === undefined` check alone would let
// `"mcpServers": null` reach the collision check below as an unactionable
// raw TypeError, and would let `"mcpServers": []` pass the collision check
// silently (an array's numeric-index write is then dropped entirely by
// JSON.stringify), reporting a successful install that wrote nothing.
function readMcpConfig(): Record<string, unknown> {
```

Replace with:

```ts
// Reads and validates .mcp.json's shape, defaulting to an empty config when
// the file doesn't exist yet. Guards `mcpServers` itself (not just the
// top-level object) against being missing, `null`, or an array: a bare
// `fileContents.mcpServers === undefined` check alone would let
// `"mcpServers": null` reach the collision check below as an unactionable
// raw TypeError, and would let `"mcpServers": []` pass the collision check
// silently (an array's numeric-index write is then dropped entirely by
// JSON.stringify), reporting a successful install that wrote nothing.
// Exported so remove.ts/update.ts can read the same validated shape when
// deciding whether it's safe to touch an mcp entry (ahood-cli#169).
export function readMcpConfig(): Record<string, unknown> {
```

- [ ] **Step 3: Extract resolveMcpServerConfig, add hashMcpServerConfig, and rewrite installMcpEntry to use both**

In `src/commands/add.ts`, find this exact block:

```ts
async function installMcpEntry(owner: string, skill: string, meta: VersionMeta, buffer: Buffer): Promise<void> {
  const content = await extractSingleFileContent(buffer, "server.json");
  const manifest = JSON.parse(content.toString("utf-8")) as ServerManifest;

  // Validate the manifest's shape (unsupported registry_type/runtime_hint,
  // or neither a single 'packages' nor a single 'remotes' entry) and check
  // for an existing .mcp.json collision BEFORE prompting for any secret --
  // an install that's going to be refused anyway must not first cost the
  // user a masked secret prompt. buildMcpServerConfig is called here with an
  // empty env purely to run its validation/throw; the result is discarded
  // and rebuilt below once secretEnv is known.
  buildMcpServerConfig(manifest, {});
  assertNoCollision(readMcpConfig(), owner, skill);

  const envVars = manifest.packages?.[0]?.environment_variables ?? [];
  const secretEnv: Record<string, string> = {};
  for (const variable of envVars) {
    if (!variable.is_secret) continue;
    const fromEnv = process.env[variable.name];
    // Truthiness, not `!== undefined` -- matches credentials.ts's
    // resolveToken(), the precedent this feature was explicitly modeled on
    // (per the design spec), which uses `if (process.env.AHOOD_TOKEN)`
    // specifically so an empty-string env var falls through to the real
    // source instead of silently installing an empty secret.
    secretEnv[variable.name] = fromEnv
      ? fromEnv
      : await promptSecret(`${sanitizeForTerminal(variable.name)} (${sanitizeForTerminal(variable.description)}): `);
  }

  const serverConfig = buildMcpServerConfig(manifest, secretEnv);

  // Read-modify-write under an advisory lock, mirroring lockfile.ts's own
  // writeLockfileEntry: .mcp.json sits right next to the lockfile and can
  // hold other servers' secrets, so it gets the same protection against a
  // truncated write or a concurrent `add` racing the same read-modify-write.
  // Re-reads and re-checks the collision here rather than trusting the
  // pre-check above, since arbitrary time may have passed since then --
  // including, in the interactive case, however long the user took at the
  // secret prompt -- during which another process could have written the
  // same entry.
  withLock(MCP_CONFIG_PATH, () => {
    const fileContents = readMcpConfig();
    assertNoCollision(fileContents, owner, skill);
    (fileContents.mcpServers as Record<string, unknown>)[skill] = serverConfig;
    writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
  });

  const mcpKey = `${owner}/${skill}`;
  try {
    writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, mcpKey, { version: meta.version, checksum_sha256: meta.checksum_sha256 });
  } catch (error) {
    if (!(error instanceof LockfileChecksumConflictError)) throw error;
    // Roll back the .mcp.json merge above under the same lock pattern --
    // re-read+delete rather than assuming nothing else changed it since.
    withLock(MCP_CONFIG_PATH, () => {
      const fileContents = readMcpConfig();
      delete (fileContents.mcpServers as Record<string, unknown>)[skill];
      writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
    });
    throw new Error(checksumConflictMessage(mcpKey, meta, error.existing));
  }
  console.log(`Installed ${owner}/${skill}@${meta.version} into ${MCP_CONFIG_PATH} as "${skill}"`);
  if (Object.keys(secretEnv).length > 0) {
    console.warn(`WARNING: ${MCP_CONFIG_PATH} now contains one or more secret values in plaintext -- do not commit it to version control.`);
  }
}
```

Replace the entire block with:

```ts
// Extracts server.json, validates its shape, and resolves every secret
// environment variable it declares (prompting only for ones not already
// set in the shell) -- the part of installing an mcp entry that's identical
// whether this is a fresh `add` or an `update` moving an existing pin
// forward. Exported so update.ts's real mcp-update path (ahood-cli#169)
// re-resolves secrets the same way a fresh install does, instead of
// duplicating this parsing/prompting logic.
export async function resolveMcpServerConfig(
  buffer: Buffer,
): Promise<{ manifest: ServerManifest; serverConfig: Record<string, unknown> }> {
  const content = await extractSingleFileContent(buffer, "server.json");
  const manifest = JSON.parse(content.toString("utf-8")) as ServerManifest;

  // Validate the manifest's shape (unsupported registry_type/runtime_hint,
  // or neither a single 'packages' nor a single 'remotes' entry) BEFORE
  // prompting for any secret -- an install/update that's going to be
  // refused anyway must not first cost the user a masked secret prompt.
  // buildMcpServerConfig is called here with an empty env purely to run its
  // validation/throw; the result is discarded and rebuilt below once
  // secretEnv is known.
  buildMcpServerConfig(manifest, {});

  const envVars = manifest.packages?.[0]?.environment_variables ?? [];
  const secretEnv: Record<string, string> = {};
  for (const variable of envVars) {
    if (!variable.is_secret) continue;
    const fromEnv = process.env[variable.name];
    // Truthiness, not `!== undefined` -- matches credentials.ts's
    // resolveToken(), the precedent this feature was explicitly modeled on
    // (per the design spec), which uses `if (process.env.AHOOD_TOKEN)`
    // specifically so an empty-string env var falls through to the real
    // source instead of silently installing an empty secret.
    secretEnv[variable.name] = fromEnv
      ? fromEnv
      : await promptSecret(`${sanitizeForTerminal(variable.name)} (${sanitizeForTerminal(variable.description)}): `);
  }

  const serverConfig = buildMcpServerConfig(manifest, secretEnv);
  return { manifest, serverConfig };
}

// Fingerprint of exactly what ahood wrote into .mcp.json's mcpServers.<skill>
// entry, stored in the lockfile alongside the version/checksum pin. Lets
// remove/update (ahood-cli#169) tell "the on-disk entry is still exactly
// what I last installed" from "something (the user, another tool) has since
// hand-edited it" -- without this, a real (not just warned-about) removal
// or update risks silently discarding an intentional local edit, the same
// class of risk assertNoCollision below exists to prevent on a *fresh*
// install. JSON.stringify's key order matches insertion order for a plain
// object, and JSON.parse's key order matches source-text order -- so this
// is stable between the object this process just built and the same object
// read back from disk later, as long as nothing reorders keys in between.
export function hashMcpServerConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

async function installMcpEntry(owner: string, skill: string, meta: VersionMeta, buffer: Buffer): Promise<void> {
  // Check for an existing .mcp.json collision BEFORE resolving secrets --
  // matches resolveMcpServerConfig's own "don't cost the user a prompt for
  // something that's going to be refused anyway" reasoning, just for the
  // collision check specifically rather than the manifest-shape check.
  assertNoCollision(readMcpConfig(), owner, skill);
  const { serverConfig } = await resolveMcpServerConfig(buffer);

  // Read-modify-write under an advisory lock, mirroring lockfile.ts's own
  // writeLockfileEntry: .mcp.json sits right next to the lockfile and can
  // hold other servers' secrets, so it gets the same protection against a
  // truncated write or a concurrent `add` racing the same read-modify-write.
  // Re-reads and re-checks the collision here rather than trusting the
  // pre-check above, since arbitrary time may have passed since then --
  // including, in the interactive case, however long the user took at the
  // secret prompt -- during which another process could have written the
  // same entry.
  withLock(MCP_CONFIG_PATH, () => {
    const fileContents = readMcpConfig();
    assertNoCollision(fileContents, owner, skill);
    (fileContents.mcpServers as Record<string, unknown>)[skill] = serverConfig;
    writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
  });

  const mcpKey = `${owner}/${skill}`;
  try {
    writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, mcpKey, {
      version: meta.version,
      checksum_sha256: meta.checksum_sha256,
      mcp_config_hash: hashMcpServerConfig(serverConfig),
    });
  } catch (error) {
    if (!(error instanceof LockfileChecksumConflictError)) throw error;
    // Roll back the .mcp.json merge above under the same lock pattern --
    // re-read+delete rather than assuming nothing else changed it since.
    withLock(MCP_CONFIG_PATH, () => {
      const fileContents = readMcpConfig();
      delete (fileContents.mcpServers as Record<string, unknown>)[skill];
      writeJsonFileAtomic(MCP_CONFIG_PATH, fileContents);
    });
    throw new Error(checksumConflictMessage(mcpKey, meta, error.existing));
  }
  console.log(`Installed ${owner}/${skill}@${meta.version} into ${MCP_CONFIG_PATH} as "${skill}"`);
  // Only the npm+npx package path ever carries secrets into `env` (headers
  // on a remote entry are static per v1's scope, per buildMcpServerConfig) --
  // checking the final serverConfig's own `env` key (rather than threading
  // secretEnv out of resolveMcpServerConfig separately) means this warning
  // can never drift from what was actually written to disk.
  if (serverConfig.env && Object.keys(serverConfig.env as Record<string, string>).length > 0) {
    console.warn(`WARNING: ${MCP_CONFIG_PATH} now contains one or more secret values in plaintext -- do not commit it to version control.`);
  }
}

// Re-runs the mcp install flow for an already-installed entry, moving its
// lockfile pin forward -- update.ts's real mcp-update path (ahood-cli#169).
// Unlike installMcpEntry, "the entry already exists" is expected here (it's
// the very entry being updated), so the safety check is inverted: rather
// than refusing because something's already there, this refuses UNLESS the
// on-disk entry's fingerprint still matches what was recorded at the last
// install/update -- same posture as assertNoCollision, applied to "is this
// still mine to touch" instead of "is this mine to create". If the entry is
// missing entirely, there's nothing to protect -- write fresh (self-heals a
// lockfile pin whose .mcp.json entry was deleted by hand without going
// through `ahood skill remove`). If it's present but doesn't match (or no
// fingerprint was ever recorded, e.g. an entry installed before this field
// existed), refuse rather than silently overwrite a possibly-intentional
// local edit.
export async function updateMcpEntry(owner: string, skill: string, meta: VersionMeta, currentEntry: LockEntry | undefined): Promise<void> {
  const key = `${owner}/${skill}`;
  const recordedHash = currentEntry?.mcp_config_hash;

  const fileContents = readMcpConfig();
  const mcpServers = fileContents.mcpServers as Record<string, unknown>;
  const existingOnDisk = Object.prototype.hasOwnProperty.call(mcpServers, skill) ? mcpServers[skill] : undefined;

  if (existingOnDisk !== undefined) {
    if (recordedHash === undefined) {
      throw new Error(
        `Cannot verify ${key}'s .mcp.json entry matches what ahood last installed (no recorded fingerprint) -- remove and reinstall to enable automatic updates.`,
      );
    }
    if (hashMcpServerConfig(existingOnDisk) !== recordedHash) {
      throw new Error(
        `${key}'s .mcp.json entry appears to have been modified since install -- refusing to overwrite it. Remove it manually first, or run \`ahood skill remove ${key}\` then \`ahood skill add ${key}\`.`,
      );
    }
  }

  const buffer = await downloadVerifiedArchive(owner, skill, meta);
  const { serverConfig } = await resolveMcpServerConfig(buffer);

  // Read-modify-write under an advisory lock, mirroring installMcpEntry's
  // own pattern. Re-checks the fingerprint here too (not just above) since
  // arbitrary time may have passed since the pre-check -- the download, and
  // any secret prompt inside resolveMcpServerConfig -- during which another
  // process could have changed the entry.
  withLock(MCP_CONFIG_PATH, () => {
    const fresh = readMcpConfig();
    const freshServers = fresh.mcpServers as Record<string, unknown>;
    const freshExisting = Object.prototype.hasOwnProperty.call(freshServers, skill) ? freshServers[skill] : undefined;
    if (freshExisting !== undefined && (recordedHash === undefined || hashMcpServerConfig(freshExisting) !== recordedHash)) {
      throw new Error(`${key}'s .mcp.json entry changed while updating -- refusing to overwrite it. Re-run \`ahood skill update ${key}\` if this was unexpected.`);
    }
    freshServers[skill] = serverConfig;
    writeJsonFileAtomic(MCP_CONFIG_PATH, fresh);
  });

  try {
    writeLockfileEntryVerifyingChecksum(LOCKFILE_PATH, key, {
      version: meta.version,
      checksum_sha256: meta.checksum_sha256,
      mcp_config_hash: hashMcpServerConfig(serverConfig),
    });
  } catch (error) {
    if (!(error instanceof LockfileChecksumConflictError)) throw error;
    throw new Error(checksumConflictMessage(key, meta, error.existing));
  }

  console.log(`Updated ${key} to ${meta.version}`);
  if (serverConfig.env && Object.keys(serverConfig.env as Record<string, string>).length > 0) {
    console.warn(`WARNING: ${MCP_CONFIG_PATH} now contains one or more secret values in plaintext -- do not commit it to version control.`);
  }
}
```

Note: this replaces the ENTIRE `installMcpEntry` function and inserts `resolveMcpServerConfig`/`hashMcpServerConfig`/`updateMcpEntry` around it, in the order shown (the three new pieces go where `installMcpEntry` used to start; `installMcpEntry` itself, now shorter, follows `hashMcpServerConfig`; `updateMcpEntry` follows `installMcpEntry`). Nothing else in `add.ts` changes — `add()` itself, `downloadVerifiedArchive`, `buildMcpServerConfig`, `assertNoCollision`, `readMcpConfig` (already modified in Step 2), `summarizeConflictingEntry`, and every type definition are untouched.

- [ ] **Step 4: Add a regression test confirming the fingerprint is stored**

In `tests/add.test.ts`, add this test inside the existing `describe("add", ...)` block, after the existing `it("installs an mcp artifact (npm package) mapping registry_type/runtime_hint to command/args", ...)` test (so it sits alongside the other mcp-install tests):

```ts
  it("stores a fingerprint of the written .mcp.json entry in the lockfile (ahood-cli#169)", async () => {
    const manifest = {
      name: "weather",
      description: "x",
      remotes: [{ url: "https://mcp.example.com/sse" }],
    };
    const archive = await tarGz({ "server.json": JSON.stringify(manifest) });
    stubApi(archive, sha256(archive), [{ path: "server.json" }], VERSION, "mcp");

    await add([`${OWNER}/${SKILL}`]);

    const lockfile = JSON.parse(readFileSync(join(dir, ".claude", "skills.lock.json"), "utf-8"));
    expect(lockfile[`${OWNER}/${SKILL}`].mcp_config_hash).toMatch(/^[0-9a-f]{64}$/);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update(JSON.stringify(mcpConfig.mcpServers[SKILL])).digest("hex");
    expect(lockfile[`${OWNER}/${SKILL}`].mcp_config_hash).toBe(expectedHash);
  });
```

- [ ] **Step 5: Run tests to verify everything passes**

Run: `npm run build && npx vitest run tests/add.test.ts`
Expected: PASS, all 38 tests (37 pre-existing + 1 new). This exact code (the `add.ts` refactor and this test) was already verified end-to-end in this repo/worktree during plan authoring — typecheck clean, this exact test passing, and every one of the 37 pre-existing `add.test.ts` tests passing unmodified against the refactor.

- [ ] **Step 6: Run the full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lockfile.ts src/commands/add.ts tests/add.test.ts
git commit -m "feat(mcp): add install-fingerprint field + shared helpers for remove/update (ahood-cli#169)"
```

---

### Task 2: Real mcp removal in remove.ts

**Files:**
- Modify: `src/commands/remove.ts`
- Test: Modify `tests/remove.test.ts`

**Interfaces:**
- Consumes: `readMcpConfig`, `hashMcpServerConfig` from `src/commands/add.js` (Task 1, must be complete and committed first). `withLock`, `writeJsonFileAtomic` from `src/lockfile.js` (already exported, unchanged).
- Produces: no new exports. `remove()`'s exported signature is unchanged; its behavior for an mcp-kind entry changes as described below.

- [ ] **Step 1: Update the imports**

In `src/commands/remove.ts`, replace:

```ts
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { confirm } from "../confirm.js";
import { readLockfile, removeLockfileEntry } from "../lockfile.js";
import { LOCKFILE_PATH, parseOwnerSkill, skillDir, agentPath, MCP_CONFIG_PATH } from "../spec.js";
import { UsageError } from "../usage-error.js";
```

with:

```ts
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { confirm } from "../confirm.js";
import { readLockfile, removeLockfileEntry, withLock, writeJsonFileAtomic } from "../lockfile.js";
import { LOCKFILE_PATH, parseOwnerSkill, skillDir, agentPath, MCP_CONFIG_PATH } from "../spec.js";
import { readMcpConfig, hashMcpServerConfig } from "./add.js";
import { UsageError } from "../usage-error.js";
```

- [ ] **Step 2: Capture the full lockfile entry (not just a boolean) before it's cleared**

Find:

```ts
  const agentFile = agentPath(owner, skill);
  const agentExisted = existsSync(agentFile);
  const hadLockfileEntry = key in readLockfile(LOCKFILE_PATH);

  if (!dirExisted && !agentExisted && !hadLockfileEntry) {
```

Replace with:

```ts
  const agentFile = agentPath(owner, skill);
  const agentExisted = existsSync(agentFile);
  const lockEntry = readLockfile(LOCKFILE_PATH)[key];
  const hadLockfileEntry = lockEntry !== undefined;

  if (!dirExisted && !agentExisted && !hadLockfileEntry) {
```

- [ ] **Step 3: Replace the warn-only mcp block with real, fingerprint-gated removal**

Find this exact block (everything from the comment starting `// An mcp-kind install has no directory...` through the final `console.log`):

```ts
  // An mcp-kind install has no directory or agent file on disk -- its only
  // footprint here is the lockfile entry just cleared above and a live
  // entry in .mcp.json (which add.ts's installMcpEntry merged in, possibly
  // holding a resolved secret in its `env`). remove() doesn't attempt a real
  // mcp removal, but staying silent about that entry repeats the exact
  // false-assurance bug already fixed once for agent installs above: a user
  // who removes an mcp artifact because they no longer trust it would be
  // told it's gone while the MCP server (and its credential) still runs on
  // the next Claude Code start -- and since the lockfile pin is now cleared,
  // nothing will ever surface this again via `list`/`update`. So: warn
  // instead of pretending it's gone.
  if (existsSync(MCP_CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
      const mcpServers = parsed?.mcpServers;
      if (
        mcpServers &&
        typeof mcpServers === "object" &&
        !Array.isArray(mcpServers) &&
        Object.prototype.hasOwnProperty.call(mcpServers, skill)
      ) {
        console.warn(
          `WARNING: ${key} still has an entry in ${MCP_CONFIG_PATH} (which may contain secrets you entered) -- remove it manually.`,
        );
      }
    } catch {
      // A malformed .mcp.json isn't this command's problem to fix or crash
      // on -- add.ts's readMcpConfig is the strict validator for that path.
      // Skip the warning rather than throw here.
    }
  }

  console.log(`Removed ${key}`);
}
```

Replace it with:

```ts
  // An mcp-kind install has no directory or agent file on disk -- its only
  // footprint here is the lockfile entry just cleared above and a live
  // entry in .mcp.json (which add.ts's installMcpEntry merged in, possibly
  // holding a resolved secret in its `env`). Real removal (delete that one
  // key) only happens when the on-disk entry's fingerprint still matches
  // what was recorded at install/update time -- same posture as add.ts's
  // own assertNoCollision: never blind-write/delete something this process
  // didn't verify it still owns. Without SOME check here, "Removed" would
  // repeat the exact false-assurance bug already fixed once for agent
  // installs above (a user told it's gone while the MCP server, and its
  // credential, still runs on the next Claude Code start) -- but a hand-
  // edited entry (fingerprint mismatch, or no fingerprint recorded at all,
  // e.g. an mcp entry installed before this field existed) is left in
  // place and warned about instead, exactly as before this fix.
  let removedMcpEntry = false;
  let mcpEntryModified = false;
  try {
    const fileContents = readMcpConfig();
    const mcpServers = fileContents.mcpServers as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(mcpServers, skill)) {
      const recordedHash = lockEntry?.mcp_config_hash;
      const currentHash = hashMcpServerConfig(mcpServers[skill]);
      if (recordedHash !== undefined) {
        mcpEntryModified = recordedHash !== currentHash;
      }
      if (recordedHash !== undefined && !mcpEntryModified) {
        // Re-check under lock rather than trusting the read above -- another
        // process could have changed or removed the entry in between,
        // mirroring add.ts's own re-check-under-lock before it writes.
        withLock(MCP_CONFIG_PATH, () => {
          const fresh = readMcpConfig();
          const freshServers = fresh.mcpServers as Record<string, unknown>;
          if (
            Object.prototype.hasOwnProperty.call(freshServers, skill) &&
            hashMcpServerConfig(freshServers[skill]) === recordedHash
          ) {
            delete freshServers[skill];
            writeJsonFileAtomic(MCP_CONFIG_PATH, fresh);
            removedMcpEntry = true;
          }
        });
      }
      if (!removedMcpEntry) {
        console.warn(
          `WARNING: ${key} still has an entry in ${MCP_CONFIG_PATH} (which may contain secrets you entered)` +
            (mcpEntryModified ? " -- it appears to have been modified since install" : "") +
            ` -- remove it manually.`,
        );
      }
    }
  } catch {
    // A malformed .mcp.json isn't this command's problem to fix or crash
    // on -- add.ts's readMcpConfig is the strict validator for that path.
    // Skip the warning rather than throw here.
  }

  console.log(removedMcpEntry ? `Removed ${key} (including its ${MCP_CONFIG_PATH} entry)` : `Removed ${key}`);
}
```

- [ ] **Step 4: Add two new tests for the real-removal and modified-entry cases**

In `tests/remove.test.ts`, add these two tests inside the existing `describe("remove", ...)` block, right after the existing `it("warns about a live .mcp.json entry left behind by an mcp install, instead of silently reporting success (finding #3)", ...)` test (that existing test now specifically covers the "no recorded fingerprint" backward-compat path — leave it completely unmodified, its assertions still hold exactly as before):

```ts
  it("actually deletes the .mcp.json entry when its recorded fingerprint still matches what's on disk (ahood-cli#169)", async () => {
    const entry = { command: "npx", args: ["-y", "@x/weather@1.0.0"], env: { API_KEY: "secret-val" } };
    writeFileSync(
      join(dir, MCP_CONFIG_PATH),
      JSON.stringify({ mcpServers: { weather: entry, other: { url: "https://x" } } }, null, 2),
    );
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
      mcp_config_hash: hashMcpServerConfig(entry),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await remove(["alice/weather", "--yes"]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toBeUndefined();
    expect(mcpConfig.mcpServers.other).toEqual({ url: "https://x" }); // sibling entry untouched
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Removed alice/weather"));
    expect(readLockfile(join(dir, ".claude", "skills.lock.json"))).toEqual({});
  });

  it("does NOT delete, and warns with 'modified' wording, when the on-disk entry no longer matches the recorded fingerprint", async () => {
    const installedEntry = { command: "npx", args: ["-y", "@x/weather@1.0.0"], env: { API_KEY: "secret-val" } };
    const handEditedEntry = { command: "npx", args: ["-y", "@x/weather@1.0.0", "--extra-flag"], env: { API_KEY: "secret-val" } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: handEditedEntry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
      mcp_config_hash: hashMcpServerConfig(installedEntry),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await remove(["alice/weather", "--yes"]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual(handEditedEntry);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/modified since install/));
  });
```

Add the import for `hashMcpServerConfig` at the top of `tests/remove.test.ts` — find:

```ts
import { remove } from "../src/commands/remove.js";
import { writeLockfileEntry, readLockfile } from "../src/lockfile.js";
import { agentPath, skillDir, MCP_CONFIG_PATH } from "../src/spec.js";
```

replace with:

```ts
import { remove } from "../src/commands/remove.js";
import { writeLockfileEntry, readLockfile } from "../src/lockfile.js";
import { agentPath, skillDir, MCP_CONFIG_PATH } from "../src/spec.js";
import { hashMcpServerConfig } from "../src/commands/add.js";
```

- [ ] **Step 5: Run tests to verify everything passes**

Run: `npm run build && npx vitest run tests/remove.test.ts`
Expected: PASS, all 13 tests (11 pre-existing + 2 new). This exact code was already verified end-to-end during plan authoring — every pre-existing test passes unmodified, and both new tests pass against this exact implementation.

- [ ] **Step 6: Run the full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/remove.ts tests/remove.test.ts
git commit -m "feat(mcp): actually delete the .mcp.json entry on remove, when safe to do so (ahood-cli#169)"
```

---

### Task 3: Real mcp update in update.ts

**Files:**
- Modify: `src/commands/update.ts`
- Test: Modify `tests/update.test.ts`

**Interfaces:**
- Consumes: `updateMcpEntry` from `src/commands/add.js` (Task 1, must be complete and committed first). No dependency on Task 2.
- Produces: no new exports. `update()`'s exported signature is unchanged; its behavior for an mcp-kind target changes as described below.

- [ ] **Step 1: Import updateMcpEntry**

In `src/commands/update.ts`, replace:

```ts
import { LOCKFILE_PATH, parseOwnerSkill } from "../spec.js";
import { readLockfile } from "../lockfile.js";
import { add, fetchVersionMeta } from "./add.js";
import { UsageError } from "../usage-error.js";
```

with:

```ts
import { LOCKFILE_PATH, parseOwnerSkill } from "../spec.js";
import { readLockfile } from "../lockfile.js";
import { add, fetchVersionMeta, updateMcpEntry } from "./add.js";
import { UsageError } from "../usage-error.js";
```

- [ ] **Step 2: Replace the skip-only mcp branch with real update logic**

Find this exact block inside the per-target `try` in `update()`:

```ts
    try {
      // add() always hits the .mcp.json collision check for an mcp-kind
      // entry that's already installed (that's the very definition of
      // "already installed" for that kind), so calling it unconditionally
      // here would make `ahood skill update` with no arguments permanently
      // report a failure and exit 1 for every user who has ever installed
      // an mcp artifact, even when nothing needs updating. fetchVersionMeta
      // already resolves `kind` as part of the normal "latest" lookup add()
      // itself does, so resolving it here first lets this skip cleanly
      // instead of updating and hitting that guaranteed error. This is a
      // skip-and-report-cleanly fix, not real mcp-update support.
      const { owner, skill } = parseOwnerSkill(ownerSlashSkill, USAGE);
      const meta = await fetchVersionMeta(owner, skill, "latest");
      if (meta.kind === "mcp") {
        console.warn(`Skipping ${ownerSlashSkill}: mcp artifacts aren't updatable via this command yet.`);
        continue;
      }
      await add([ownerSlashSkill]); // no @version -- resolves to latest again
```

Replace it with:

```ts
    try {
      // add() always hits the .mcp.json collision check for an mcp-kind
      // entry that's already installed (that's the very definition of
      // "already installed" for that kind), so it can never be called
      // unconditionally here the way it is for skill/agent kinds below --
      // fetchVersionMeta resolves `kind` as part of the normal "latest"
      // lookup add() itself does, so resolving it here first lets an
      // mcp-kind entry route to updateMcpEntry (ahood-cli#169's real
      // mcp-update support) instead.
      const { owner, skill } = parseOwnerSkill(ownerSlashSkill, USAGE);
      const meta = await fetchVersionMeta(owner, skill, "latest");
      if (meta.kind === "mcp") {
        const currentEntry = lockfile[ownerSlashSkill];
        if (currentEntry && currentEntry.version === meta.version) {
          // Matches skill/agent update's own "nothing to do" case for a
          // pin that's already at latest -- not a warning (nothing's
          // wrong), and, unlike skill/agent (which always blindly
          // re-extracts even when nothing changed), skipped here
          // specifically so an up-to-date mcp entry with a secret in its
          // env never re-triggers a masked prompt for no reason.
          console.log(`${ownerSlashSkill} is already up to date (v${meta.version}).`);
          continue;
        }
        await updateMcpEntry(owner, skill, meta, currentEntry);
        continue;
      }
      await add([ownerSlashSkill]); // no @version -- resolves to latest again
```

Nothing else in `update()` (or the rest of the file — `previewSkill`, `printDryRunTable`, the `--dry-run` branch, the final failure-count reporting) changes.

- [ ] **Step 3: Update the one existing test whose expected behavior changes, and add three new tests**

In `tests/update.test.ts`, find this exact test:

```ts
  it("skips an installed mcp artifact with a clean status message instead of always failing (finding #2)", async () => {
    // add() always hits the .mcp.json collision check for an mcp entry that's
    // already installed -- without a skip, `ahood skill update` with no args
    // would report 1 failure and exit 1 for every user who has an mcp
    // artifact installed, even when nothing needs updating.
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/alice/weather`) {
        return new Response(
          JSON.stringify({
            skill_versions: { version: "1.0.0", manifest: [{ path: "server.json" }], checksum_sha256: "abc" },
            kind: "mcp",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // The download endpoint must never be hit for a skipped mcp entry.
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await update([]);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("alice/weather"));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/download"))).toBe(false);
  });
```

Replace it with:

```ts
  it("reports an already-up-to-date mcp artifact as a clean status, not a warning or failure (ahood-cli#169)", async () => {
    // Real mcp-update support (ahood-cli#169) means an mcp entry is no
    // longer unconditionally skipped -- but one already at "latest" still
    // has nothing to do, and (unlike skill/agent, which always blindly
    // re-extracts even when unchanged) is deliberately short-circuited
    // before hitting /download, so an up-to-date entry with a secret in its
    // env never re-triggers a masked prompt for no reason.
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "abc",
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/alice/weather`) {
        return new Response(
          JSON.stringify({
            skill_versions: { version: "1.0.0", manifest: [{ path: "server.json" }], checksum_sha256: "abc" },
            kind: "mcp",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // The download endpoint must never be hit for an already-up-to-date entry.
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await update([]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("alice/weather is already up to date"));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/download"))).toBe(false);
  });

  it("performs a real update when a newer version is available and the fingerprint matches (ahood-cli#169)", async () => {
    const oldEntry = { url: "https://mcp.example.com/v1/sse" };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: oldEntry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "old-checksum",
      mcp_config_hash: hashMcpServerConfig(oldEntry),
    });

    const manifest = { name: "weather", description: "x", remotes: [{ url: "https://mcp.example.com/v2/sse" }] };
    const archive = await tarGz({ "server.json": JSON.stringify(manifest) });
    const checksum = sha256(archive);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/weather`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: checksum },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/weather/download?version=2.0.0`) {
          return new Response(new Uint8Array(archive), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await update([]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual({ url: "https://mcp.example.com/v2/sse" });
    const lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    expect(lockfile["alice/weather"].version).toBe("2.0.0");
    expect(lockfile["alice/weather"].mcp_config_hash).toBe(hashMcpServerConfig({ url: "https://mcp.example.com/v2/sse" }));
    expect(process.exitCode).not.toBe(1);
  });

  it("refuses to update when the on-disk entry doesn't match the recorded fingerprint (hand-edited) (ahood-cli#169)", async () => {
    const installedEntry = { url: "https://mcp.example.com/v1/sse" };
    const handEditedEntry = { url: "https://mcp.example.com/v1/sse", headers: { "X-Custom": "added-by-hand" } };
    writeFileSync(join(dir, MCP_CONFIG_PATH), JSON.stringify({ mcpServers: { weather: handEditedEntry } }, null, 2));
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "old-checksum",
      mcp_config_hash: hashMcpServerConfig(installedEntry),
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${API_URL}/api/v1/skills/alice/weather`) {
        return new Response(
          JSON.stringify({
            skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: "irrelevant" },
            kind: "mcp",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await update([]);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/modified since install/));
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/download"))).toBe(false);
    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual(handEditedEntry);
    const lockfile = readLockfile(join(dir, ".claude", "skills.lock.json"));
    expect(lockfile["alice/weather"].version).toBe("1.0.0"); // pin NOT moved forward
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("self-heals by installing fresh when the .mcp.json entry is missing despite a lockfile pin (ahood-cli#169)", async () => {
    // No .mcp.json file at all -- e.g. deleted by hand without going through `ahood skill remove`.
    writeLockfileEntry(join(dir, ".claude", "skills.lock.json"), "alice/weather", {
      version: "1.0.0",
      checksum_sha256: "old-checksum",
      mcp_config_hash: "some-stale-hash-that-cant-match-anything",
    });

    const manifest = { name: "weather", description: "x", remotes: [{ url: "https://mcp.example.com/v2/sse" }] };
    const archive = await tarGz({ "server.json": JSON.stringify(manifest) });
    const checksum = sha256(archive);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API_URL}/api/v1/skills/alice/weather`) {
          return new Response(
            JSON.stringify({
              skill_versions: { version: "2.0.0", manifest: [{ path: "server.json" }], checksum_sha256: checksum },
              kind: "mcp",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === `${API_URL}/api/v1/skills/alice/weather/download?version=2.0.0`) {
          return new Response(new Uint8Array(archive), { status: 200 });
        }
        return new Response(JSON.stringify({ error: `unexpected: ${url}` }), { status: 404 });
      }),
    );

    await update([]);

    const mcpConfig = JSON.parse(readFileSync(join(dir, MCP_CONFIG_PATH), "utf-8"));
    expect(mcpConfig.mcpServers.weather).toEqual({ url: "https://mcp.example.com/v2/sse" });
    expect(process.exitCode).not.toBe(1);
  });
```

Add the two new imports these tests need at the top of `tests/update.test.ts` — find:

```ts
import { update } from "../src/commands/update.js";
import { writeLockfileEntry } from "../src/lockfile.js";
import { skillDir } from "../src/spec.js";
```

replace with:

```ts
import { update } from "../src/commands/update.js";
import { writeLockfileEntry, readLockfile } from "../src/lockfile.js";
import { skillDir, MCP_CONFIG_PATH } from "../src/spec.js";
import { hashMcpServerConfig } from "../src/commands/add.js";
```

And add `writeFileSync` to the existing `node:fs` import — find:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
```

replace with:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npm run build && npx vitest run tests/update.test.ts`
Expected: PASS, all 12 tests (9 pre-existing, one of them rewritten in place, plus 3 new). This exact code was already verified end-to-end during plan authoring.

- [ ] **Step 5: Run the full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/update.ts tests/update.test.ts
git commit -m "feat(mcp): actually update the .mcp.json entry, when safe to do so (ahood-cli#169)"
```

---

### Task 4: Documentation

**Files:**
- Modify: `src/help.ts`

**Interfaces:** None — no new exports, no new files. `README.md` is regenerated by `npm run sync-readme` but confirmed during plan authoring not to change (only `desc`, not `summary`, changes).

- [ ] **Step 1: Update the update command's desc**

In `src/help.ts`, find:

```ts
    usage: "ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]",
    summary: "Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once.",
    desc: "Move the lockfile pin(s) forward to the latest version. With no argument, updates every installed skill; one failure doesn't stop the rest.",
```

Replace with:

```ts
    usage: "ahood skill update [<owner>/<skill> ...] [--dry-run] [--json]",
    summary: "Move the lockfile pin(s) forward to the latest version, for one skill or all installed skills at once.",
    desc:
      "Move the lockfile pin(s) forward to the latest version. With no argument, updates every installed skill; one failure doesn't stop the rest. " +
      "An mcp-kind entry is updated in place (re-resolving any secret environment variables) as long as its .mcp.json entry still matches what " +
      "ahood last installed there -- a hand-edited or unverifiable entry is refused rather than silently overwritten.",
```

- [ ] **Step 2: Update the remove command's desc**

In `src/help.ts`, find:

```ts
    usage: "ahood skill remove <owner>/<skill> [--yes]",
    summary: "Uninstall and unpin a skill (local only, prompts for confirmation unless --yes is passed).",
    desc: "Uninstall and unpin (local only). Prompts for confirmation unless --yes is passed.",
```

Replace with:

```ts
    usage: "ahood skill remove <owner>/<skill> [--yes]",
    summary: "Uninstall and unpin a skill (local only, prompts for confirmation unless --yes is passed).",
    desc:
      "Uninstall and unpin (local only). Prompts for confirmation unless --yes is passed. For an mcp-kind install, " +
      "also deletes its .mcp.json entry as long as it still matches what ahood last installed there -- a hand-edited " +
      "or unverifiable entry is left in place and warned about instead of being silently touched.",
```

- [ ] **Step 3: Confirm README.md doesn't need regenerating, then verify the CI check anyway**

Run: `npx tsc -p tsconfig.json --noEmit` (expect clean), then `npm run build && node scripts/sync-readme.mjs --check` (expect "README.md's command table is up to date." -- confirmed during plan authoring that changing only `desc`, not `summary`, leaves the generated table unaffected).

- [ ] **Step 4: Run the full suite one more time**

Run: `npm run build && npm test`
Expected: all tests passing (35 files / 465 total: the pre-existing 33/455 baseline, minus the one Task 3 test that got rewritten in place rather than added, plus Task 1's +1, Task 2's +2, and Task 3's +3 net-new tests -- treat the exact final count as a sanity check against what Tasks 1-3 actually landed, not a hard-coded gate, since another PR could have merged to `main` in the meantime).

- [ ] **Step 5: Commit**

```bash
git add src/help.ts
git commit -m "docs: mention mcp-aware remove/update behavior in CLI help (ahood-cli#169)"
```

---

## Self-Review Notes (from plan authoring)

- **Spec coverage:** issue #169's two asks map directly: "teach remove to delete the corresponding mcpServers.<skill> entry... respecting the same collision-safety posture" → Task 2's fingerprint-gated delete. "teach update to re-run the install flow for mcp entries (re-resolving secrets, respecting the same collision rules)" → Task 3's `updateMcpEntry`, built on Task 1's `resolveMcpServerConfig` (the exact same secret-resolution code path `installMcpEntry` uses).
- **Every task's exact code (all four source-file diffs and every new/rewritten test) was written, typechecked, and run together in this repo/worktree during plan authoring** — `npx tsc -p tsconfig.json --noEmit` clean, full suite green (35 files / 465 tests including this plan's own additions, up from the 33/455 baseline confirmed at plan-authoring start), and `node scripts/sync-readme.mjs --check` confirmed passing after the `help.ts` changes. All three new/rewritten test scenarios (real delete with a sibling-entry-untouched check, hash-mismatch refusal on both remove and update, self-heal on a missing update target) were independently verified to pass against this exact implementation before being written into this plan.
- **Task boundaries reflect real dependencies:** Task 2 and Task 3 both need Task 1's exports (`readMcpConfig`, `hashMcpServerConfig`, `updateMcpEntry`) to exist, but are independent of each other (different files, no shared state) — either can run second. Task 4 is independent of Tasks 2/3's internals (pure documentation) but conceptually describes their behavior, so it's sequenced last.
- **Placeholder scan:** every step has literal before/after code, no "TBD"/"add appropriate handling"/deferred content anywhere in this plan.
