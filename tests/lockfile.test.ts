import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readLockfile,
  withLock,
  writeLockfileEntry,
  removeLockfileEntry,
  writeLockfileEntryVerifyingChecksum,
  LockfileChecksumConflictError,
  currentHostIdentity,
} from "../src/lockfile.js";

describe("lockfile", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ahood-lock-test-"));
    lockPath = join(dir, ".claude", "skills.lock.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty object when no lockfile exists", () => {
    expect(readLockfile(lockPath)).toEqual({});
  });

  it("writes and reads back an entry", () => {
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc123" });
    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc123" },
    });
  });

  it("preserves other entries when writing a new one", () => {
    writeLockfileEntry(lockPath, "alice/skill-a", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "bob/skill-b", { version: "2.0.0", checksum_sha256: "bbb" });
    expect(Object.keys(readLockfile(lockPath))).toEqual(["alice/skill-a", "bob/skill-b"]);
  });

  it("overwrites an existing entry for the same skill (used by update)", () => {
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.1.0", checksum_sha256: "bbb" });
    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.1.0", checksum_sha256: "bbb" },
    });
  });

  it("removeLockfileEntry deletes exactly the named entry", () => {
    writeLockfileEntry(lockPath, "alice/skill-a", { version: "1.0.0", checksum_sha256: "aaa" });
    writeLockfileEntry(lockPath, "bob/skill-b", { version: "2.0.0", checksum_sha256: "bbb" });
    removeLockfileEntry(lockPath, "alice/skill-a");
    expect(readLockfile(lockPath)).toEqual({
      "bob/skill-b": { version: "2.0.0", checksum_sha256: "bbb" },
    });
  });

  it("throws instead of silently discarding a corrupted lockfile", () => {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "{not valid json");
    expect(() => readLockfile(lockPath)).toThrow(/corrupted/);
  });

  it("does not lose entries across many back-to-back writes (lock acquire/release round-trips cleanly)", async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() =>
        writeLockfileEntry(lockPath, `owner/skill-${i}`, { version: "1.0.0", checksum_sha256: `hash-${i}` }),
      ),
    );
    await Promise.all(writes);
    expect(Object.keys(readLockfile(lockPath))).toHaveLength(8);
  });

  it("reclaims a lock directory left behind by a process that no longer exists, instead of hanging until the timeout (#100)", () => {
    const lockDir = `${lockPath}.lock`;
    mkdirSync(lockDir, { recursive: true });
    // A process that has already exited by the time spawnSync returns --
    // its pid is guaranteed dead (barring the astronomically unlikely case
    // of immediate pid reuse), simulating a hard-killed (SIGKILL/OOM) lock
    // holder.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(lockDir, "pid"), String(dead.pid));

    const start = Date.now();
    writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });
    const elapsed = Date.now() - start;

    expect(readLockfile(lockPath)).toEqual({
      "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc" },
    });
    // Reclaimed almost immediately -- the old code path would instead sit in
    // the wait/retry loop for close to the full 5s timeout.
    expect(elapsed).toBeLessThan(2000);
    expect(existsSync(lockDir)).toBe(false);
  });

  describe("an unremovable stale lock (#140)", () => {
    // Every case here runs withLock in a real child process, the way
    // tests/index.test.ts exercises the built CLI, because the regression
    // being guarded is an infinite *synchronous* loop: it blocks the event
    // loop, so no in-process test timeout could ever interrupt it, and only a
    // process the OS can kill bounds it.
    //
    // `patch` is CJS run before the import, with `lockPath`/`lockDir`/`fs` in
    // scope. Mutating the `node:fs` module object from CJS is visible to the
    // named imports inside the loaded ESM, which is what lets a case script
    // the exact removal failure it needs instead of depending on what the
    // filesystem underneath the test happens to do.
    function withLockInChild(patch = ""): { child: ReturnType<typeof spawnSync>; elapsed: number } {
      const builtLockfile = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lockfile.js");
      expect(existsSync(builtLockfile), "run `npm run build` before the tests -- these cases need dist/").toBe(true);
      const script = `
        const fs = require("node:fs");
        const lockPath = ${JSON.stringify(lockPath)};
        const lockDir = lockPath + ".lock";
        ${patch}
        import(${JSON.stringify(pathToFileURL(builtLockfile).href)}).then(({ withLock }) => {
          try { withLock(lockPath, () => {}); console.log("ACQUIRED"); }
          catch (error) { console.log("THREW " + error.message); }
        });`;
      const start = Date.now();
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
      return { child, elapsed: Date.now() - start };
    }

    // A lock directory whose recorded holder has already exited by the time
    // spawnSync returns -- its pid is guaranteed dead (barring the
    // astronomically unlikely case of immediate pid reuse), the shape a
    // hard-killed (SIGKILL/OOM) holder leaves behind.
    function plantStaleLock(): string {
      const lockDir = `${lockPath}.lock`;
      mkdirSync(lockDir, { recursive: true });
      const dead = spawnSync(process.execPath, ["-e", ""]);
      writeFileSync(join(lockDir, "pid"), String(dead.pid));
      return lockDir;
    }

    // The property that matters in every case below, whatever the wording of
    // the error: the call came back on its own (a signal means the timeout
    // above had to kill a spin), and it did not hand out a lock it never took.
    function expectGaveUpOnItsOwn(child: ReturnType<typeof spawnSync>): void {
      expect(child.signal, `withLock never returned; it spun past its own deadline (stderr: ${child.stderr})`).toBe(
        null,
      );
      expect(child.stdout).toContain("THREW");
      expect(child.stdout).not.toContain("ACQUIRED");
    }

    // Removing the lock directory needs write permission on its PARENT, and
    // removing the pid file inside it needs write permission on the lock
    // directory ITSELF. Dropping both is what makes this case independent of
    // its environment: a recursive removal that can take neither leaves the
    // whole thing exactly as it was, so the retry keeps seeing a stale lock,
    // on every Node version and filesystem. (Root bypasses both checks, and
    // the condition simply cannot be provoked there.)
    it.skipIf(process.getuid?.() === 0)(
      "gives up within its deadline instead of spinning forever, and names the real problem",
      () => {
        const lockDir = plantStaleLock();
        const guardedDir = dirname(lockPath);
        chmodSync(lockDir, 0o500);
        chmodSync(guardedDir, 0o500);

        let result: ReturnType<typeof withLockInChild>;
        try {
          result = withLockInChild();
        } finally {
          // Before any assertion, so a failure still leaves afterEach able to
          // delete the temp directory.
          chmodSync(guardedDir, 0o700);
          chmodSync(lockDir, 0o700);
        }

        expectGaveUpOnItsOwn(result.child);
        // The message must name the real problem -- a directory this process
        // cannot remove -- not "waiting for a lock", which would send the user
        // hunting for an ahood process that provably exited.
        expect(result.child.stdout).toContain("Could not reclaim the stale lock");
        expect(result.child.stdout).toContain(lockDir);
        expect(result.child.stdout).toContain("delete it manually");
        // withLock's own deadline is 5s; anything near the kill above means it
        // spun instead of giving up.
        expect(result.elapsed).toBeLessThan(20_000);
      },
      60_000,
    );

    // The CI-only failure behind ahood-cli#145: a recursive removal deletes
    // the directory's CONTENTS and only then fails on the directory itself,
    // so the pid file is gone by the next retry -- and a lock with no pid
    // file is deliberately "not stale" (another process may be mid-acquire),
    // so the reclaim branch never runs again. Whether that partial removal
    // happens at all differs between Node versions, which is why it is
    // scripted here rather than provoked through the filesystem.
    it(
      "still reports the unremovable lock when the failed removal took the pid file with it",
      () => {
        const lockDir = plantStaleLock();

        const { child } = withLockInChild(`
          const realRmSync = fs.rmSync;
          fs.rmSync = (target, options) => {
            if (target !== lockDir) return realRmSync(target, options);
            realRmSync(lockDir + "/pid", { force: true });
            const error = new Error("EACCES: permission denied, rmdir");
            error.code = "EACCES";
            throw error;
          };
        `);

        expectGaveUpOnItsOwn(child);
        expect(child.stdout).toContain("Could not reclaim the stale lock");
        expect(child.stdout).toContain("EACCES");
        expect(child.stdout).not.toContain("Timed out waiting for the lock");
      },
      60_000,
    );

    // The other half of remembering a reclaim failure: the memory must not
    // outlive the directory it describes. A process that DOES have permission
    // (a root/owner ahood in another terminal) can clear that directory and
    // take the lock for real, and "the process that held it is gone" would
    // then be a confident lie about a lock somebody is legitimately holding.
    it(
      "falls back to the plain timeout when the directory it failed to remove was replaced by a live holder",
      () => {
        plantStaleLock();

        const { child } = withLockInChild(`
          const realRmSync = fs.rmSync;
          fs.rmSync = (target, options) => {
            if (target !== lockDir) return realRmSync(target, options);
            fs.rmSync = realRmSync;
            realRmSync(lockDir, { recursive: true, force: true });
            fs.mkdirSync(lockDir);
            fs.writeFileSync(lockDir + "/pid", String(process.pid));
            const error = new Error("EACCES: permission denied, rmdir");
            error.code = "EACCES";
            throw error;
          };
        `);

        expectGaveUpOnItsOwn(child);
        expect(child.stdout).toContain("Timed out waiting for the lock");
        expect(child.stdout).not.toContain("Could not reclaim the stale lock");
      },
      60_000,
    );
  });

  describe("two waiters racing to reclaim one stale lock (#141)", () => {
    const builtLockfile = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lockfile.js");

    // A lock directory whose recorded holder has already exited by the time
    // spawnSync returns -- the shape a hard-killed (SIGKILL/OOM) holder leaves
    // behind, and the precondition for a reclaim.
    function plantStaleLock(): string {
      const lockDir = `${lockPath}.lock`;
      mkdirSync(lockDir, { recursive: true });
      const dead = spawnSync(process.execPath, ["-e", ""]);
      writeFileSync(join(lockDir, "pid"), String(dead.pid));
      return lockDir;
    }

    // Two real child processes, because the race is between PROCESSES and
    // withLock is synchronous: nothing inside a single Node process can ever
    // interleave two of its critical sections, so an in-process test could not
    // reproduce this bug at all.
    //
    // The interleaving is FORCED, not hoped for, by two scripted gates:
    //
    //   1. A barrier on the first read of the `pid` file -- the read inside
    //      isLockStale. Neither child gets past it until both have read the
    //      SAME dead pid, which is steps 1-3 of the issue: two waiters judging
    //      one dead holder stale off one snapshot. Each child reports whether
    //      the barrier actually met, so a barrier that quietly timed out
    //      cannot pass itself off as a success.
    //   2. A one-shot gate in the LATE child only, on its removal of the lock
    //      directory: it holds that removal until the other child is provably
    //      inside its critical section. That is step 5 -- the delete landing
    //      on a live successor's lock instead of on the dead holder's.
    //
    // Only the late child is gated, so the early one never waits on it and the
    // pair cannot deadlock; both gates are bounded regardless.
    function raceChild(role: string, hook: string, log: string, barrierDir: string): Promise<string> {
      const script = `
        const fs = require("node:fs");
        const lockPath = ${JSON.stringify(lockPath)};
        const lockDir = lockPath + ".lock";
        const pidFile = lockDir + "/pid";
        const log = ${JSON.stringify(log)};
        const barrierDir = ${JSON.stringify(barrierDir)};
        const role = ${JSON.stringify(role)};
        const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        const realReadFileSync = fs.readFileSync;
        let barrier = "BARRIER-NEVER-REACHED";
        let atBarrier = false;
        fs.readFileSync = (target, ...rest) => {
          if (target === pidFile && !atBarrier) {
            atBarrier = true;
            fs.writeFileSync(barrierDir + "/" + role, "");
            const until = Date.now() + 5000;
            while (fs.readdirSync(barrierDir).length < 2 && Date.now() < until) sleep(5);
            barrier = fs.readdirSync(barrierDir).length === 2 ? "BARRIER-OK" : "BARRIER-TIMEOUT";
          }
          return realReadFileSync(target, ...rest);
        };
        ${hook}
        import(${JSON.stringify(pathToFileURL(builtLockfile).href)}).then(({ withLock }) => {
          try {
            withLock(lockPath, () => {
              fs.appendFileSync(log, "ENTER " + role + "\\n");
              sleep(400);
              fs.appendFileSync(log, "EXIT " + role + "\\n");
            });
            console.log("ACQUIRED " + role + " " + barrier);
          } catch (error) {
            console.log("THREW " + role + " " + error.message);
          }
        });`;
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ["-e", script]);
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.on("close", () => resolve(stdout));
      });
    }

    it(
      "never lets both of them into the critical section at once",
      async () => {
        expect(existsSync(builtLockfile), "run `npm run build` before the tests -- this case needs dist/").toBe(true);
        plantStaleLock();
        const log = join(dir, "critical-section.log");
        const barrierDir = join(dir, "barrier");
        writeFileSync(log, "");
        mkdirSync(barrierDir);

        const [early, late] = await Promise.all([
          raceChild("early", "", log, barrierDir),
          raceChild(
            "late",
            `
              const realRmSync = fs.rmSync;
              let gated = false;
              fs.rmSync = (target, options) => {
                if (target === lockDir && !gated) {
                  gated = true;
                  const until = Date.now() + 1500;
                  while (Date.now() < until && !realReadFileSync(log, "utf8").includes("ENTER")) sleep(5);
                }
                return realRmSync(target, options);
              };
            `,
            log,
            barrierDir,
          ),
        ]);

        // Proof the race was actually staged: both children sat at the barrier
        // until the other arrived, so both really did judge the same dead
        // holder stale before either acted on that judgement.
        expect(early).toContain("BARRIER-OK");
        expect(late).toContain("BARRIER-OK");
        // Both get in eventually -- the loser waits the winner out rather than
        // failing.
        expect(early).toContain("ACQUIRED");
        expect(late).toContain("ACQUIRED");

        const events = readFileSync(log, "utf-8").trim().split("\n");
        let inside = 0;
        let mostInsideAtOnce = 0;
        for (const event of events) {
          inside += event.startsWith("ENTER") ? 1 : -1;
          mostInsideAtOnce = Math.max(mostInsideAtOnce, inside);
        }
        expect(mostInsideAtOnce, `critical sections overlapped: ${events.join(" | ")}`).toBe(1);
        expect(events).toHaveLength(4);
      },
      60_000,
    );

    it("does not delete a successor's lock on release after its own was taken away", () => {
      const lockDir = `${lockPath}.lock`;
      const pidFile = join(lockDir, "pid");
      // A live process that is definitely not this one, standing in for the
      // waiter that reclaimed this lock after wrongly judging its holder dead.
      const successorPid = String(process.ppid);

      withLock(lockPath, () => {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeFileSync(pidFile, successorPid);
      });

      expect(existsSync(lockDir), "the successor's lock was deleted by the process it displaced").toBe(true);
      expect(readFileSync(pidFile, "utf-8")).toBe(successorPid);
    });

    it("still releases a lock it holds without a pid file of its own", () => {
      // The pid write is best-effort, so a lock whose pid file never landed is
      // reachable. Release must not skip such a directory: nothing can ever
      // judge a pid-less lock stale, so leaving it behind strands every later
      // add/remove/update in that project until a human deletes it by hand.
      const lockDir = `${lockPath}.lock`;
      const script = `
        const fs = require("node:fs");
        const lockDir = ${JSON.stringify(lockDir)};
        const realWriteFileSync = fs.writeFileSync;
        fs.writeFileSync = (target, ...rest) => {
          if (target === lockDir + "/pid") {
            const error = new Error("EACCES: permission denied, open");
            error.code = "EACCES";
            throw error;
          }
          return realWriteFileSync(target, ...rest);
        };
        import(${JSON.stringify(pathToFileURL(builtLockfile).href)}).then(({ withLock }) => {
          withLock(${JSON.stringify(lockPath)}, () => {
            if (fs.existsSync(lockDir + "/pid")) throw new Error("the pid file was supposed to be unwritable");
          });
          console.log("RELEASED");
        });`;
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });

      expect(child.stdout, child.stderr).toContain("RELEASED");
      expect(existsSync(lockDir)).toBe(false);
    });
  });

  describe("lock host identity (#157)", () => {
    const builtLockfile = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lockfile.js");

    // A lock directory whose recorded holder has already exited by the time
    // spawnSync returns -- the guaranteed-dead-pid shape the tests above use
    // for a hard-killed (SIGKILL/OOM) holder -- with an optional `host` line.
    function plantLock(pid: number | string, host: string | undefined): string {
      const lockDir = `${lockPath}.lock`;
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "pid"), String(pid));
      if (host !== undefined) writeFileSync(join(lockDir, "host"), host);
      return lockDir;
    }

    function deadPid(): number {
      return spawnSync(process.execPath, ["-e", ""]).pid as number;
    }

    // The deadline is 5s of real time; jumping Date.now past it (the same
    // trick the timeout-message tests below use) reaches the timeout branch
    // without spending it.
    function waitForLockWithStoppedClock(): Error {
      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 10_000);
      let caught: unknown;
      try {
        withLock(lockPath, () => {
          throw new Error("the critical section must not run while the lock is held");
        });
      } catch (error) {
        caught = error;
      }
      return caught as Error;
    }

    it("records this host's identity in the lock directory while it is held", () => {
      withLock(lockPath, () => {
        const lockDir = `${lockPath}.lock`;
        expect(readFileSync(join(lockDir, "host"), "utf-8")).toBe(currentHostIdentity());
        // The pid file stays a bare decimal pid: a <=0.9.0 reader must still
        // be able to parse a lock this version wrote.
        expect(readFileSync(join(lockDir, "pid"), "utf-8")).toBe(String(process.pid));
      });
    });

    it("reclaims a same-host lock with a dead pid, host line and all", () => {
      const lockDir = plantLock(deadPid(), currentHostIdentity());

      const start = Date.now();
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });

      // Reclaimed almost immediately, not waited out to the deadline: the
      // host line must not turn a locally-reclaimable lock into a 5s stall.
      expect(Date.now() - start).toBeLessThan(2000);
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc" },
      });
      expect(existsSync(lockDir)).toBe(false);
    });

    it("treats a legacy <=0.9.0 lock (bare pid, no host line) as same-host and reclaims it", () => {
      // The missing-host-means-same-host decision, pinned: a stale local lock
      // left by an older version stays reclaimable instead of becoming
      // unreclaimable-until-deadline behind a foreign-host verdict.
      const lockDir = plantLock(deadPid(), undefined);

      const start = Date.now();
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });

      expect(Date.now() - start).toBeLessThan(2000);
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc" },
      });
      expect(existsSync(lockDir)).toBe(false);
    });

    it("never reclaims a lock recorded on another host, and times out naming it", () => {
      // Machine id chosen to differ from whatever this host has, so the
      // foreign verdict holds on machines with and without /etc/machine-id.
      const foreignIdentity = "0123456789abcdef0123456789abcdef\nsome-other-host";
      const pid = deadPid();
      const lockDir = plantLock(pid, foreignIdentity);

      const error = waitForLockWithStoppedClock();

      expect(error.message).toContain("another host");
      expect(error.message).toContain("some-other-host");
      expect(error.message).toContain(lockDir);
      // Not the generic timeout: that wording invites deleting a lock that may
      // belong to a live process on the machine named above.
      expect(error.message).not.toContain("delete that directory manually");
      // Not reclaimed either: the foreign holder may still be alive where it
      // runs, which is exactly what this host cannot check.
      expect(existsSync(lockDir)).toBe(true);
      expect(readFileSync(join(lockDir, "pid"), "utf-8")).toBe(String(pid));
    });

    it("never judges a lock with an unreadable pid stale, host line or not", () => {
      // Pre-#157 behaviour, kept: a pid file that doesn't parse means "not
      // stale" (the acquirer may be mid-way through setting the record up),
      // and adding the host line must not change that. The lock is waited
      // out, not reclaimed.
      const lockDir = plantLock("not-a-pid", currentHostIdentity());

      const error = waitForLockWithStoppedClock();

      expect(error.message).toBe(
        `Timed out waiting for the lock on ${lockPath} at ${lockDir}. If no other ahood process is running, delete that directory manually.`,
      );
      expect(existsSync(lockDir)).toBe(true);
    });

    it("still works end to end when the host line write fails (best-effort, like the pid)", () => {
      // The pid write is best-effort and the host write inherits that: a lock
      // whose host line never landed must acquire, run its critical section,
      // and release cleanly -- degrading to pid-only staleness, not failing.
      const lockDir = `${lockPath}.lock`;
      const script = `
        const fs = require("node:fs");
        const realWriteFileSync = fs.writeFileSync;
        fs.writeFileSync = (target, ...rest) => {
          if (target === ${JSON.stringify(join(lockDir, "host"))}) {
            const error = new Error("EACCES: permission denied, open");
            error.code = "EACCES";
            throw error;
          }
          return realWriteFileSync(target, ...rest);
        };
        import(${JSON.stringify(pathToFileURL(builtLockfile).href)}).then(({ withLock }) => {
          withLock(${JSON.stringify(lockPath)}, () => {
            if (fs.existsSync(${JSON.stringify(join(lockDir, "host"))})) throw new Error("the host file was supposed to be unwritable");
          });
          console.log("RELEASED");
        });`;
      const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });

      expect(child.stdout, child.stderr).toContain("RELEASED");
      expect(existsSync(lockDir)).toBe(false);
      // The pid-only lock it left behind is gone with it, so the next acquirer
      // takes the lock cleanly rather than waiting it out.
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });
      expect(readLockfile(lockPath)["alice/my-skill"]).toEqual({ version: "1.0.0", checksum_sha256: "abc" });
    });
  });

  describe("withLock timeout message", () => {
    // Holds the lock with THIS process's pid so isLockStale can't reclaim it,
    // then jumps Date.now past withLock's deadline on the first in-loop read,
    // so the timeout branch is reached without spending its real 5s.
    function timeoutMessageFor(path: string): string {
      const lockDir = `${path}.lock`;
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      const start = Date.now();
      vi.spyOn(Date, "now").mockReturnValueOnce(start).mockReturnValue(start + 10_000);

      let caught: unknown;
      try {
        withLock(path, () => {
          throw new Error("the critical section must not run while the lock is held");
        });
      } catch (error) {
        caught = error;
      }
      return (caught as Error).message;
    }

    it("names the guarded file when the lock being waited on guards .mcp.json (#123)", () => {
      const mcpPath = join(dir, ".mcp.json");

      const message = timeoutMessageFor(mcpPath);

      expect(message).toBe(
        `Timed out waiting for the lock on ${mcpPath} at ${mcpPath}.lock. If no other ahood process is running, delete that directory manually.`,
      );
      // The whole point of #123: a .mcp.json timeout must not send the user
      // looking at "the lockfile".
      expect(message).not.toMatch(/lockfile/i);
    });

    it("still reads correctly for a timeout on the real lockfile", () => {
      const message = timeoutMessageFor(lockPath);

      expect(message).toBe(
        `Timed out waiting for the lock on ${lockPath} at ${lockPath}.lock. If no other ahood process is running, delete that directory manually.`,
      );
    });
  });

  describe("writeLockfileEntryVerifyingChecksum", () => {
    it("writes normally when there is no conflicting entry", () => {
      writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "abc" });
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "abc" },
      });
    });

    it("overwrites cleanly when the existing entry is for a different version (an update, not a conflict)", () => {
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });
      writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.1.0", checksum_sha256: "bbb" });
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.1.0", checksum_sha256: "bbb" },
      });
    });

    it("throws LockfileChecksumConflictError and leaves the existing entry untouched on a same-version checksum mismatch (#101)", () => {
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "aaa" });

      let caught: unknown;
      try {
        writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "tampered" });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(LockfileChecksumConflictError);
      expect((caught as LockfileChecksumConflictError).existing).toEqual({ version: "1.0.0", checksum_sha256: "aaa" });
      // The lockfile itself must be unchanged -- the conflicting write never landed.
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "aaa" },
      });
    });

    it("catches a conflict written by a concurrent writer AFTER an earlier unlocked read saw none, closing the TOCTOU window", () => {
      // Simulates add()'s early, unlocked fast-fail check seeing no entry at
      // all, then -- before this call's OWN locked check-and-write runs -- a
      // "concurrent process" (represented here by a plain writeLockfileEntry
      // call in between) pins a conflicting checksum for the same version.
      expect(readLockfile(lockPath)["alice/my-skill"]).toBeUndefined();
      writeLockfileEntry(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "concurrent-writer-won" });

      expect(() =>
        writeLockfileEntryVerifyingChecksum(lockPath, "alice/my-skill", { version: "1.0.0", checksum_sha256: "this-writer-lost" }),
      ).toThrow(LockfileChecksumConflictError);
      expect(readLockfile(lockPath)).toEqual({
        "alice/my-skill": { version: "1.0.0", checksum_sha256: "concurrent-writer-won" },
      });
    });
  });
});
