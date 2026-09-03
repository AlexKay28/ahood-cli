import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { removeLockfileEntry } from "../lockfile.js";
import { LOCKFILE_PATH, parseOwnerSkill, skillDir, agentPath, MCP_CONFIG_PATH } from "../spec.js";

const USAGE = "Usage: ahood remove <owner>/<skill>";

export async function remove(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error(USAGE);
  const { owner, skill } = parseOwnerSkill(spec, USAGE);
  const key = `${owner}/${skill}`;

  const dir = skillDir(owner, skill);
  const dirExisted = existsSync(dir);
  if (dirExisted) rmSync(dir, { recursive: true, force: true });

  // Sweep the owner directory once it holds nothing, so uninstalling an
  // owner's last skill doesn't leave an empty namespace folder behind (npm
  // does the same with node_modules/@scope). Guarded on emptiness, so another
  // skill by the same owner is never touched.
  const ownerDir = dirname(dir);
  if (existsSync(ownerDir) && readdirSync(ownerDir).length === 0) rmdirSync(ownerDir);

  // An agent installs as a single flat file (.claude/agents/<owner>@<skill>.md),
  // never a directory under .claude/skills/ -- skillDir's rmSync above never
  // touches it. Without this, removing an installed agent silently left the
  // file on disk (still loaded by Claude Code forever) while reporting
  // success and clearing the lockfile entry, so a later `update` wouldn't
  // catch it either (ahood-cli final review finding #2).
  const agentFile = agentPath(owner, skill);
  const agentExisted = existsSync(agentFile);
  if (agentExisted) unlinkSync(agentFile);

  const hadLockfileEntry = removeLockfileEntry(LOCKFILE_PATH, key);

  if (!dirExisted && !agentExisted && !hadLockfileEntry) {
    console.error(`${key} was not installed -- nothing to remove.`);
    process.exitCode = 1;
    return;
  }

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
