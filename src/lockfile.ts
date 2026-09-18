import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";

// mcp_config_hash is only ever set for a kind='mcp' entry (add.ts's
// installMcpEntry) -- a fingerprint of exactly what was written into
// .mcp.json's mcpServers.<skill> entry at install/update time, letting
// remove/update (ahood-cli#169) tell an untouched entry from a hand-edited
// one before deleting or overwriting it. Absent for skill/agent entries,
// and absent for any mcp entry installed before this field existed.
export type LockEntry = { version: string; checksum_sha256: string; mcp_config_hash?: string };
export type Lockfile = Record<string, LockEntry>;

export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    // Silently treating a corrupted lockfile as "nothing installed" is how
    // every existing pin gets permanently discarded on the very next write --
    // refuse instead, so a truncated/interrupted write is a loud, fixable
    // error rather than silent data loss.
    throw new Error(
      `Lockfile at ${path} is corrupted and could not be parsed as JSON. Fix or delete it before continuing.`,
    );
  }
}

// Signal 0 doesn't deliver anything, it just probes whether the process could
// be signaled. ESRCH means it's gone; EPERM means it's alive but owned by
// someone else, which is conservatively treated as still alive since that
// can't be disproven. Shared by the stale-lock reclaim (ahood-cli#100) and the
// stale-temp sweep (ahood-cli#125) so both answer "is the process that left
// this behind still around?" the same way, rather than growing two divergent
// staleness rules.
function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

// Exactly what the temp name below produces: a decimal pid and a decimal
// hrtime, nothing else. Anything the user merely happened to name
// `<basename>.tmp-something` fails this and is left alone -- deleting a file
// that was never ours is far worse than leaving a stale temp file behind
// (ahood-cli#125).
const TEMP_SUFFIX_RE = /^([1-9][0-9]{0,9})-[0-9]{1,25}$/;

// The finally in writeJsonFileAtomic can't run on SIGKILL, an OOM kill or
// power loss, so a temp file can still be orphaned in the window between the
// write and the rename -- and for .mcp.json that orphan holds resolved MCP
// server secrets under a name nothing else ever removes (ahood-cli#125). The
// next successful write to the same destination collects them.
//
// withLock serializes the writers this CLI itself starts, but a temp file is
// only provably collectable once the process that created it is gone, so the
// pid embedded in the name is checked rather than trusting the lock alone. A
// pid recycled since the last boot can only make a dead writer look alive,
// which just defers the cleanup; it can never make a live writer look dead, so
// this never deletes a file still being written.
function sweepStaleTempFiles(path: string, ownTempName: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.tmp-`;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === ownTempName) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const match = TEMP_SUFFIX_RE.exec(entry.name.slice(prefix.length));
    if (!match) continue;
    if (!isPidDead(Number(match[1]))) continue;
    try {
      rmSync(join(dir, entry.name), { force: true });
    } catch {
      // One unremovable orphan must not stop the rest of the sweep.
    }
  }
}

// How many links deep resolveWriteTarget will follow before declaring a cycle.
// Same order of magnitude as the kernel's own ceiling (40 on Linux); the exact
// number doesn't matter, only that a self-referential link terminates with an
// actionable error instead of spinning.
const MAX_SYMLINK_HOPS = 32;

// THE CONTRACT: a symlinked destination is written THROUGH, onto the file the
// link resolves to, and the link itself is left in place.
//
// The alternative -- letting renameSync replace the link with a regular file,
// which is what this used to do -- is indefensible for .mcp.json in
// particular: symlinking it at a shared or out-of-tree config is how a user
// keeps MCP server secrets OUT of the project directory, so replacing the link
// drops those secrets into precisely the directory the arrangement exists to
// keep them out of, while the real config silently keeps stale content.
// ahood-cli#119's mode preservation made that harder to notice rather than
// easier, since the file left behind carried the target's permissions
// (ahood-cli#144).
//
// Refusing outright (lstat, throw "this must be a regular file") was the other
// candidate, and was rejected: every caller here READS the same path first,
// through the link -- add.ts merges the existing .mcp.json, the lockfile
// writers merge the existing pins -- so a read-modify-write that reads the
// target and writes anywhere else is incoherent no matter which file ends up
// holding the result. Refusing would also make a crash-safety implementation
// detail visible as a hard failure: the plain writeFileSync this replaced
// followed the link, as does every editor and every shell redirection, and the
// callers have no idea a symlink is involved at all.
//
// lstatSync, never statSync, and deliberately so: statSync follows the link and
// therefore cannot answer the only question asked here ("is this path itself a
// link?"). Asking it with statSync is the original bug -- the mode came back
// from the link's target and was then applied to the regular file that had
// taken the link's place.
function resolveWriteTarget(path: string): string {
  let current = path;
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      // Nothing at this path: either a brand-new destination, or the dangling
      // end of a chain whose final target doesn't exist yet -- a user who sets
      // the symlink up before the first install. Write there, so the link
      // starts resolving to the file the caller's next read will follow it to.
      return current;
    }
    if (!isLink) return current;
    const link = readlinkSync(current);
    current = isAbsolute(link) ? link : resolve(dirname(current), link);
  }
  throw new Error(
    `Refusing to write ${path}: it resolves through more than ${MAX_SYMLINK_HOPS} symlinks, so the chain loops back on itself. Repoint or delete that link.`,
  );
}

// Generalized so callers other than the lockfile itself (e.g. add.ts's
// .mcp.json merge, which sits right next to the lockfile and can hold other
// servers' secrets) get the same crash-safety guarantee instead of a bare
// writeFileSync that risks truncating the file on interruption.
//
// `mode` (ahood-cli#158) lets a caller decide the mode of a file this write
// CREATES: installMcpEntry requests 0600 when the payload it just resolved
// holds a credential, because only the caller knows whether the data is a
// secret store or a shared config. It never applies to an existing
// destination -- that file's mode is its owner's (or another tool's) choice,
// and preserving it is #119's whole point -- so an existing file is untouched
// no matter what is requested, and the caller learns about a loose existing
// file some other way (the warning in add.ts). Omitted, the fallback stays
// exactly what a plain writeFileSync would have produced. An explicitly
// requested mode is applied exactly, via the post-rename chmod below, rather
// than umask-masked at creation: a caller making a security decision about a
// file it is creating must get what it asked for regardless of the ambient
// umask.
export function writeJsonFileAtomic(path: string, data: unknown, mode?: number): void {
  // Resolved before the mkdir so the directory that actually gets created is
  // the resolved target's, not the link's -- a link set up ahead of the first
  // install can point somewhere that doesn't exist yet -- and so that every
  // step below (temp file, rename, chmod, sweep) names the same single file.
  const dest = resolveWriteTarget(path);
  mkdirSync(dirname(dest), { recursive: true });
  // Write-then-rename so a process interrupted mid-write never leaves a
  // truncated file on disk -- a reader always sees either the old or the new
  // complete content, never a partial one.
  //
  // The temp file must be a sibling of the RESOLVED destination rather than of
  // `path`: renameSync cannot cross filesystems (EXDEV), and an out-of-tree
  // target -- a different mount, a home directory on another volume -- is
  // exactly the case a symlinked .mcp.json is used for. Deriving the temp name
  // from `dest` keeps the rename inside one directory and keeps #119's
  // `finally` unlink and #125's sweep pointed at the directory this code
  // actually creates temp files in (ahood-cli#144).
  const tmpPath = `${dest}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  // The mode the destination must end up with. Preserving an existing file's
  // permissions matters because .mcp.json is a project-shared config other MCP
  // clients read: whether it should be 0644 or tighter is its own decision
  // (ahood#169), not something this write path gets to change as a side effect
  // of the 0600 temp file below (ahood-cli#119) -- and that is true even when
  // the caller passed `mode`, which therefore only ever governs creation. With
  // no destination yet there is nothing to preserve: an explicit request wins
  // (see the comment above), and without one the fallback is what a plain
  // writeFileSync would have produced -- 0666 masked by the process umask.
  //
  // lstatSync rather than statSync even though `dest` is by construction never
  // a symlink (resolveWriteTarget walked until it wasn't): the two agree here,
  // and lstat says so at the call site instead of leaving a link-following stat
  // one refactor away from reintroducing #144.
  let finalMode: number;
  try {
    finalMode = lstatSync(dest).mode & 0o777;
  } catch {
    finalMode = mode !== undefined ? mode & 0o777 : 0o666 & ~process.umask();
  }
  try {
    // 0600 from the moment of creation: for .mcp.json this temp file holds
    // resolved MCP server secrets, and it must never be world-readable, not
    // even for the instant before the rename (ahood-cli#119).
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmpPath, dest);
    try {
      chmodSync(dest, finalMode);
    } catch {
      // Best-effort, and deliberately after the rename rather than on the temp
      // file: widening the temp file first would reopen the world-readable
      // window this fix closes. A failure here leaves the file MORE restrictive
      // than intended, never less, so it isn't worth failing a write that has
      // already landed -- the caller would roll back a successful install.
    }
    try {
      sweepStaleTempFiles(dest, basename(tmpPath));
      // Every version before ahood-cli#144 put its temp file next to the LINK
      // instead of next to the target, so a crash under one of those can have
      // stranded a plaintext-secret orphan there that no later write would ever
      // look at again. One extra sweep of the link's own directory retires them.
      if (dest !== path) sweepStaleTempFiles(path, basename(tmpPath));
    } catch {
      // Swallowed for the same reason as the chmod above and #119's unlink:
      // the rename has already landed, so failing to tidy up somebody else's
      // abandoned temp file must never turn a successful write into an error
      // the caller rolls back (ahood-cli#125).
    }
  } finally {
    // The rename consumes the temp file on success; this only bites when the
    // write or the rename threw, where an orphaned *.tmp-* copy of .mcp.json
    // would strand plaintext secrets under a name no .gitignore rule matches
    // (ahood-cli#119). Swallowed because it must never mask the real reason
    // the write failed -- that error is what the caller has to report.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort, see comment above
    }
  }
}

function writeLockfile(path: string, lockfile: Lockfile): void {
  writeJsonFileAtomic(path, lockfile);
}

// The pid recorded in a lock directory by its acquirer below, or undefined if
// there is no readable, plausible one: no pid file at all (a lock from before
// this file existed, or one whose acquirer is still mid-way through setting it
// up -- mkdirSync succeeded, the pid write hasn't landed yet), or contents
// that don't parse as a pid.
function readLockPid(pidFile: string): number | undefined {
  let pidText: string;
  try {
    pidText = readFileSync(pidFile, "utf-8");
  } catch {
    return undefined;
  }
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// ---- the host identity a lock records alongside its pid (ahood-cli#157) ----
//
// process.kill(pid, 0) answers only for THIS host's pid namespace, but the
// lock lives on a filesystem that may be shared (a bind mount, an NFS export,
// two containers on one volume), so a live holder on another host reads as
// ESRCH here and its lock gets reclaimed out from under it. The lock record
// therefore carries the holder's host identity, and a lock recorded on a
// host other than this one is never judged stale at all.

type HostIdentity = { machineId?: string; hostname: string };

// /etc/machine-id is the stable per-machine identifier on systemd Linux:
// stable across reboots, distinct per machine. Hostname alone is not a
// sufficient identity -- two containers from the same image routinely share
// it -- so the machine id anchors the comparison wherever it exists. Read
// errors are swallowed (macOS has no such file; a read can also fail) and
// leave the identity to the hostname alone, the same best-effort posture the
// pid write below already takes.
function readMachineId(): string | undefined {
  try {
    const machineId = readFileSync("/etc/machine-id", "utf-8").trim();
    return machineId.length > 0 ? machineId : undefined;
  } catch {
    return undefined;
  }
}

// The exact string written into a lock's `host` file: first line the machine
// id (empty when this host has none), second line the hostname. Computed once
// and cached -- neither value can change under a running process, and the
// retry loop below re-checks staleness every 25ms. Exported so a test can
// plant a lock recorded by THIS host (a foreign one just writes any other
// string), and so the format a reader must parse has exactly one definition.
let cachedHostIdentity: string | undefined;
export function currentHostIdentity(): string {
  cachedHostIdentity ??= `${readMachineId() ?? ""}\n${hostname()}`;
  return cachedHostIdentity;
}

function parseHostIdentity(text: string): HostIdentity {
  const newline = text.indexOf("\n");
  // No newline: tolerate hostname-only content rather than reading the whole
  // line as a machine id that could never match.
  if (newline === -1) return { hostname: text };
  return { machineId: text.slice(0, newline) || undefined, hostname: text.slice(newline + 1) };
}

// A recorded identity matches this host when the machine ids agree, or -- when
// either side has no machine id -- the hostnames do. Machine id deliberately
// wins over hostname where both exist: the same machine-id under a different
// hostname is the same machine (renamed), while a shared hostname over
// different machine ids is exactly the two-containers-from-one-image case
// hostname-only matching cannot tell apart -- the bug this exists to close.
function isSameHost(recorded: string): boolean {
  const ours = parseHostIdentity(currentHostIdentity());
  const theirs = parseHostIdentity(recorded);
  if (ours.machineId && theirs.machineId) return ours.machineId === theirs.machineId;
  return ours.hostname === theirs.hostname;
}

// The `host` file a lock records its holder's identity in, or undefined when
// there is no readable one: no host file at all, or contents that trim to
// nothing. See isLockStale for what a missing host line means.
function readLockHost(hostFile: string): string | undefined {
  try {
    const host = readFileSync(hostFile, "utf-8").trim();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

// A lock directory is stale if the pid recorded inside it belongs to a process
// that's no longer running, per isPidDead above -- but only a lock recorded on
// THIS host: the pid probe cannot see another host's processes, so a lock
// whose host line names a different machine is treated as live and waited out
// no matter what the pid probe answers (ahood-cli#157). A missing host line is
// judged by pid alone, exactly as <=0.9.0 code judged every lock: the only
// such locks are legacy ones and those whose best-effort host write failed,
// and reading them as foreign instead would strand every stale local lock
// behind a misleading "held on another host" timeout -- a regression #100's
// reclaim exists to prevent, in exchange for keeping only the pre-#157 status
// quo, which disappears as soon as a lock carries a host line.
//
// No readable pid still means "not stale": safer to wait out a lock that may
// still be being set up than to reclaim one that is actually held.
function isLockStale(pidFile: string, hostFile: string): boolean {
  const pid = readLockPid(pidFile);
  if (pid === undefined) return false;
  const host = readLockHost(hostFile);
  return (host === undefined || isSameHost(host)) && isPidDead(pid);
}

// Deliberately NOT the negation of isLockStale: with no readable pid at all a
// lock is neither stale nor demonstrably held, and the two callers want
// opposite answers in that case. Reclaiming needs proof the holder is dead
// (hence isLockStale), while withLock's deadline branch needs proof that
// someone is alive before it backs off a reclaim failure it already observed.
// A foreign-host lock counts as held no matter what the pid probe answers:
// that holder is exactly the process this machine cannot see (ahood-cli#157).
function isLockHeldByLiveProcess(pidFile: string, hostFile: string): boolean {
  const host = readLockHost(hostFile);
  if (host !== undefined && !isSameHost(host)) return true;
  const pid = readLockPid(pidFile);
  return pid !== undefined && !isPidDead(pid);
}

// Name of the reclaim claim directory created inside a lock directory that is
// about to be reclaimed. A single well-known name, deliberately not a
// per-process one: its entire job is to be a name exactly one process can
// create.
const RECLAIM_CLAIM = "reclaiming";

// Reclaiming a stale lock is a claim-verify-remove, not the bare
// check-then-delete it used to be: two waiters could both judge the SAME dead
// holder stale off the same snapshot, and then the second one's rmSync would
// delete the first one's freshly-taken, live lock -- two processes inside the
// critical section at once, which is the exact lost update on .mcp.json /
// skills.lock.json that withLock exists to prevent (ahood-cli#141).
//
// The claim is a directory created INSIDE the lock directory, so it rides on
// the same mkdir atomicity the lock itself is built on: exactly one waiter can
// create it, and the losers fall through to the ordinary wait. Two
// alternatives were weighed and rejected:
//   - Merely re-reading the pid immediately before the rmSync narrows the
//     window but never closes it; the check and the unlink still aren't atomic.
//   - renameSync-ing the lock directory itself to a unique name makes the
//     rename the claim, but a rename succeeds against WHATEVER directory sits
//     at that path -- a live successor's included -- and it leaves the lock
//     path briefly absent, so a third process can mkdir it and acquire for
//     real. That manufactures two live holders rather than preventing them.
// This claim never removes or rewrites anything a holder owns and never makes
// the lock path vanish, so mutual exclusion survives even a claim that turns
// out to have been a mistake.
//
// Winning the claim is what makes the staleness verdict trustworthy, which is
// why the pid is re-read UNDER it: the directory judged stale a moment ago may
// already have been reclaimed and retaken by someone alive. Once the claim is
// held and the pid still reads dead, nothing else can remove that directory --
// a release by its holder is ruled out by that dead pid, and every other
// reclaimer is blocked by the claim -- so the verdict still holds at the moment
// of the rmSync below.
//
// Returns the error to remember for withLock's deadline branch (see
// ahood-cli#140), or undefined when there is nothing worth remembering.
function reclaimStaleLock(lockDir: string, pidFile: string, hostFile: string): NodeJS.ErrnoException | undefined {
  const claim = join(lockDir, RECLAIM_CLAIM);
  try {
    mkdirSync(claim);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST means another waiter is reclaiming this very directory right now
    // and ENOENT that it is already gone; both resolve themselves on the next
    // retry. Anything else (EACCES/EPERM/EROFS on a directory this process
    // cannot write into) is a reclaim that can never succeed, and is what the
    // deadline branch reports instead of a misleading "waiting for the lock".
    if (code === "EEXIST" || code === "ENOENT") return undefined;
    return existsSync(lockDir) ? (error as NodeJS.ErrnoException) : undefined;
  }
  if (!isLockStale(pidFile, hostFile)) {
    // Not the directory that was judged stale after all -- it was reclaimed and
    // retaken while this process looked, or it belongs to a holder that hasn't
    // written its pid yet. Hand the claim back, leaving the lock exactly as it
    // was found.
    try {
      rmSync(claim, { recursive: true, force: true });
    } catch {
      // Best effort: the holder's own release takes this directory, claim and
      // all, with it. Worst case is a lock nothing reclaims, which times out
      // with an actionable message rather than corrupting anything -- the same
      // outcome as a process killed between the two syscalls above.
    }
    return undefined;
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(lockDir)) return error as NodeJS.ErrnoException;
  }
  return undefined;
}

// Simple advisory lock via mkdir's atomicity (EEXIST on a second caller),
// so two concurrent `ahood skill add`/`remove` invocations against the same
// project don't race a read-modify-write and silently drop one another's
// entry. Exported so other same-directory JSON files with the same
// read-modify-write shape (e.g. add.ts's .mcp.json merge) can reuse it
// instead of duplicating the pattern.
//
// The lock directory holds a `pid` file naming its holder, so a process
// that finds the lock held can tell a live holder from one that was
// hard-killed (SIGKILL/OOM) mid-critical-section: without this, such a lock
// is never released, and every subsequent add/remove/update in that project
// busy-waits out the full timeout below and then fails permanently until a
// human manually deletes the stale directory (ahood-cli#100). It also holds
// a `host` file recording WHERE that holder ran, because a pid is only
// meaningful on the machine it belongs to: on a shared filesystem a live
// holder on another host reads as dead here, and reclaiming its lock puts
// two processes inside the critical section at once (ahood-cli#157).
export function withLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockDir = `${path}.lock`;
  const pidFile = join(lockDir, "pid");
  const hostFile = join(lockDir, "host");
  const deadline = Date.now() + 5000;
  // Set when the lock was judged stale but could not actually be removed and
  // that directory is still sitting there -- see the reclaim branch below.
  // Reported instead of the generic timeout, because "another process holds
  // the lock" sends the user hunting for a process that provably no longer
  // exists (ahood-cli#140).
  let reclaimError: NodeJS.ErrnoException | undefined;
  // Whether this process's own pid ever made it into the lock directory --
  // what lets the release below tell its own lock from a successor's.
  let wrotePid = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      // Best-effort: mkdirSync above is what actually holds the lock: if
      // this write fails for some reason, the lock is still correctly held,
      // just without staleness detection for this particular acquisition.
      try {
        writeFileSync(pidFile, String(process.pid));
        wrotePid = true;
        // Best-effort like the pid write above, and for the same reason:
        // mkdirSync is what actually holds the lock. A lock whose host line
        // never landed carries no host identity and is judged exactly as
        // pre-#157 code judged every lock -- by pid alone (see isLockStale's
        // missing-host rule) -- so a failed write here degrades to today's
        // behaviour rather than to something new.
        writeFileSync(hostFile, currentHostIdentity());
      } catch {
        // non-fatal, see comment above
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // The deadline is tested FIRST so that every retry path is bounded by
      // it. The reclaim branch below used to `continue` straight past both
      // this check and the sleep, so a stale lock this process could not
      // actually remove (rmSync's force:true suppresses only ENOENT, never
      // EACCES/EPERM/EROFS) turned into an unbounded 100%-CPU spin that never
      // threw and never printed anything -- the one thing a CLI built to run
      // unattended in CI must never do (ahood-cli#140).
      if (Date.now() > deadline) {
        // The remembered failure is re-confirmed here rather than trusted,
        // because a process that DOES have permission (a root/owner ahood in
        // another terminal) can clear that directory and take the lock for
        // real while this one waits -- and "the process that held it is gone"
        // would then be a confident lie about a lock somebody is legitimately
        // holding. Re-confirming asks exactly what the message claims: is
        // there still a directory, and is nobody alive holding it? Identity
        // (inode, birthtime) deliberately isn't used for this: a removed and
        // immediately recreated directory routinely gets the same inode back,
        // so it can't tell a replacement from the original anyway.
        if (reclaimError && existsSync(lockDir) && !isLockHeldByLiveProcess(pidFile, hostFile)) {
          throw new Error(
            `Could not reclaim the stale lock on ${path} at ${lockDir}: ${reclaimError.code ?? reclaimError.message}. The process that held it is gone, but this one cannot remove that directory -- delete it manually (it may belong to another user, e.g. left behind by a sudo/root run, or sit on a read-only filesystem).`,
          );
        }
        // A lock recorded on another host never reaches the reclaim branch
        // (isLockStale refuses to judge it stale), so its timeout lands here.
        // Name the holder's host rather than falling through to the generic
        // message: the pid in that lock is dead by this host's lights, so "if
        // no other ahood process is running" reads as permission to delete a
        // lock that may well belong to a live process this machine cannot see
        // (ahood-cli#157).
        const recordedHost = readLockHost(hostFile);
        if (recordedHost !== undefined && !isSameHost(recordedHost)) {
          const holder = parseHostIdentity(recordedHost);
          const holderPid = readLockPid(pidFile);
          const holderParts = [
            `hostname "${holder.hostname}"`,
            ...(holder.machineId ? [`machine id ${holder.machineId}`] : []),
            ...(holderPid !== undefined ? [`pid ${holderPid}`] : []),
          ].join(", ");
          throw new Error(
            `Timed out waiting for the lock on ${path} at ${lockDir}: it is held on another host (${holderParts}), which this machine cannot probe for liveness. If nothing on that host holds it any more, delete that directory.`,
          );
        }
        throw new Error(
          `Timed out waiting for the lock on ${path} at ${lockDir}. If no other ahood process is running, delete that directory manually.`,
        );
      }
      if (isLockStale(pidFile, hostFile)) {
        // Reclaim it. Two very different conditions can fail that, and only
        // one of them is the race the old comment here claimed: if the
        // directory is GONE afterwards, a concurrent process reclaimed it (or
        // a live holder released it) first, which is harmless -- the retry
        // below simply takes the lock. If it is still THERE, this process
        // cannot remove it at all, and retrying can only fail the same way,
        // so the failure is remembered for the deadline branch above rather
        // than swallowed (ahood-cli#140). It is remembered rather than thrown
        // immediately because a mid-reclaim race can also surface as e.g.
        // ENOTEMPTY with the directory still present, and that one does clear
        // itself on the next attempt.
        //
        // The memory deliberately survives later iterations (hence `??`
        // rather than a plain assignment): a failed recursive removal can take
        // the `pid` file with it (it deletes the contents, then fails on the
        // directory itself -- which of the two happens before the error is an
        // implementation detail that differs between Node versions), and
        // without a pid file isLockStale reports "not stale", so this branch
        // never runs again and there is no second chance to observe the
        // failure. Clearing it per-iteration made the error message depend on
        // that detail, which is why it read correctly on one machine and fell
        // back to the generic timeout on another (ahood-cli#145).
        reclaimError = reclaimStaleLock(lockDir, pidFile, hostFile) ?? reclaimError;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    // Releasing used to be an unconditional rmSync, which is only correct for
    // as long as this process still holds the lock it took -- and it does not
    // always. A reclaimer that judged this process dead can delete this lock
    // out from under a running critical section (ahood-cli#141 on one host,
    // and the host-local pid probe above across a container bind mount or a
    // network share), and the unconditional removal then took the SUCCESSOR's
    // lock down with it, turning one lost update into a chain of them.
    // Removing only a directory that still records THIS process's pid keeps
    // the damage to the process that was wronged.
    //
    // A pid file that is unreadable despite having been written is left alone
    // for the same reason: the only thing that removes it is a reclaimer
    // partway through taking this lock, so whatever is at that path is no
    // longer this process's to delete.
    //
    // With no pid of this process's own ever written (the best-effort write
    // above failed) there is nothing to compare against -- and nothing to
    // protect either, since a lock directory with no readable pid is never
    // judged stale and so can never have been reclaimed. Removing it
    // unconditionally is then both safe and necessary: leaving it behind
    // strands a lock that nothing is able to reclaim.
    if (!wrotePid || readLockPid(pidFile) === process.pid) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

export function writeLockfileEntry(path: string, ownerSlashSkill: string, entry: LockEntry): void {
  withLock(path, () => {
    const lockfile = readLockfile(path);
    lockfile[ownerSlashSkill] = entry;
    writeLockfile(path, lockfile);
  });
}

// Thrown by writeLockfileEntryVerifyingChecksum -- carries the conflicting
// entry so the caller (add.ts) can build its own user-facing message and
// decide what to roll back (an already-extracted skill dir, an already-
// written agent file, an already-merged .mcp.json entry).
export class LockfileChecksumConflictError extends Error {
  constructor(public existing: LockEntry) {
    super("Lockfile checksum conflict");
  }
}

// add.ts's checksum-pin tamper-detection guard used to read the lockfile
// (unlocked) well before the eventual writeLockfileEntry call, which
// acquires its OWN, separate lock later -- two independently-locked steps,
// not one atomic operation. Under concurrent installs of "the same"
// version with different (tampered) checksums, both processes' unlocked
// reads could see no conflict, so both writes would proceed and whichever
// wins the later lock silently overwrites the other with no error ever
// surfaced -- exactly the tampering this guard exists to catch
// (ahood-cli#101). Performing the read, the check, and the write inside one
// locked critical section closes that window: whichever caller's write
// actually lands is checked against the lockfile state as it exists AT
// THAT MOMENT, not a possibly-stale snapshot from earlier.
export function writeLockfileEntryVerifyingChecksum(path: string, ownerSlashSkill: string, entry: LockEntry): void {
  withLock(path, () => {
    const lockfile = readLockfile(path);
    const existing = lockfile[ownerSlashSkill];
    if (existing && existing.version === entry.version && existing.checksum_sha256 !== entry.checksum_sha256) {
      throw new LockfileChecksumConflictError(existing);
    }
    lockfile[ownerSlashSkill] = entry;
    writeLockfile(path, lockfile);
  });
}

export function removeLockfileEntry(path: string, ownerSlashSkill: string): boolean {
  return withLock(path, () => {
    const lockfile = readLockfile(path);
    const existed = ownerSlashSkill in lockfile;
    delete lockfile[ownerSlashSkill];
    writeLockfile(path, lockfile);
    return existed;
  });
}
