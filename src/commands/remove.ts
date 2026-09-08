import { existsSync, rmSync, unlinkSync } from "node:fs";
import { confirm } from "../confirm.js";
import { readLockfile, removeLockfileEntry, withLock, writeJsonFileAtomic } from "../lockfile.js";
import { LOCKFILE_PATH, parseOwnerSkill, skillDir, agentPath, MCP_CONFIG_PATH } from "../spec.js";
import { readMcpConfig, hashMcpServerConfig } from "./add.js";
import { UsageError } from "../usage-error.js";

const USAGE = "Usage: ahood skill remove <owner>/<skill> [--yes]";

export async function remove(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new UsageError(USAGE);
  const yes = args.includes("--yes");
  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  const key = `${owner}/${skill}`;

  // Flat owner@skill directory (see skillDir's comment in spec.ts) -- no
  // owner-namespace folder to sweep afterward, unlike the old nested layout.
  const dir = skillDir(owner, skill);
  const dirExisted = existsSync(dir);
  // An agent installs as a single flat file (.claude/agents/<owner>@<skill>.md),
  // never a directory under .claude/skills/ -- distinct from the dir check above.
  const agentFile = agentPath(owner, skill);
  const agentExisted = existsSync(agentFile);
  const lockEntry = readLockfile(LOCKFILE_PATH)[key];
  const hadLockfileEntry = lockEntry !== undefined;

  if (!dirExisted && !agentExisted && !hadLockfileEntry) {
    console.error(`${key} was not installed -- nothing to remove.`);
    process.exitCode = 1;
    return;
  }

  // Matches unpublish.ts/group.ts's confirm-before-destroy pattern (CLAUDE.md:
  // "Destructive commands ... prompt for confirmation unless --yes is passed").
  // Checked only once something is actually installed, so a no-op remove of an
  // uninstalled skill never blocks on a prompt (ahood-cli#98).
  const confirmed = yes ? true : await confirm(`Remove ${key} from this project? Type "yes" to confirm: `);
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  if (dirExisted) rmSync(dir, { recursive: true, force: true });
  if (agentExisted) unlinkSync(agentFile);
  removeLockfileEntry(LOCKFILE_PATH, key);

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
  let mcpEntryPresent = false;
  let recordedHash: string | undefined;
  try {
    const fileContents = readMcpConfig();
    const mcpServers = fileContents.mcpServers as Record<string, unknown>;
    mcpEntryPresent = Object.prototype.hasOwnProperty.call(mcpServers, skill);
    if (mcpEntryPresent) {
      recordedHash = lockEntry?.mcp_config_hash;
      const currentHash = hashMcpServerConfig(mcpServers[skill]);
      if (recordedHash !== undefined) {
        mcpEntryModified = recordedHash !== currentHash;
      }
    }
  } catch {
    // A malformed .mcp.json isn't this command's problem to fix or crash
    // on -- add.ts's readMcpConfig is the strict validator for that path.
    // mcpEntryPresent stays false, so there's nothing to warn about either:
    // if we can't even read the file, we can't know whether this skill has
    // an entry in it.
  }

  if (mcpEntryPresent && recordedHash !== undefined && !mcpEntryModified) {
    try {
      // Re-check under lock rather than trusting the read above -- another
      // process could have changed or removed the entry in between,
      // mirroring add.ts's own re-check-under-lock before it writes. This
      // try/catch is deliberately separate from the read above: a failure
      // HERE (a lock-acquisition timeout, an EACCES/ENOSPC/etc. write
      // failure) must still fall through to the warning below rather than
      // being silently swallowed -- letting it share the read's catch block
      // was the exact bug that let a failed delete print a bare "Removed"
      // with the credential still live (the false-assurance case this
      // whole mechanism exists to prevent).
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
    } catch {
      // removedMcpEntry stays false -- falls through to the warning below.
    }
  }

  if (mcpEntryPresent && !removedMcpEntry) {
    console.warn(
      `WARNING: ${key} still has an entry in ${MCP_CONFIG_PATH} (which may contain secrets you entered)` +
        (mcpEntryModified ? " -- it appears to have been modified since install" : "") +
        ` -- remove it manually.`,
    );
  }

  console.log(removedMcpEntry ? `Removed ${key} (including its ${MCP_CONFIG_PATH} entry)` : `Removed ${key}`);
}
