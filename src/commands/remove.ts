import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { confirm } from "../confirm.js";
import { readLockfile, removeLockfileEntry } from "../lockfile.js";
import { LOCKFILE_PATH, parseOwnerSkill, skillDir, agentPath, MCP_CONFIG_PATH } from "../spec.js";
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
  const hadLockfileEntry = key in readLockfile(LOCKFILE_PATH);

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
