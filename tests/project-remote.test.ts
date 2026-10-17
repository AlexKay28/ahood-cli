import { describe, expect, it } from "vitest";
import { normalizeProjectRemote } from "../src/project-remote.js";

// ahood-cli#185: the CLI must spell a git remote exactly the way the ahood
// server does (ahood lib/projects/normalize-project-remote.ts, #778), or a
// lookup by remote misses. These cases are the server's own test table.
describe("normalizeProjectRemote (mirrors the server)", () => {
  const ok = (value: string) => ({ ok: true, value });

  it.each([
    ["github.com/owner/repo", "github.com/owner/repo"],
    ["GitHub.com/Owner/Repo", "github.com/owner/repo"],
    ["https://github.com/owner/repo", "github.com/owner/repo"],
    ["https://github.com/owner/repo.git", "github.com/owner/repo"],
    ["https://github.com/owner/repo/", "github.com/owner/repo"],
    ["https://github.com/owner/repo.git/", "github.com/owner/repo"],
    ["http://github.com/owner/repo", "github.com/owner/repo"],
    ["https://user:secret-token@github.com/owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@github.com:2222/owner/repo.git", "github.com/owner/repo"],
    ["git://github.com/owner/repo.git", "github.com/owner/repo"],
    ["git@github.com:owner/repo.git", "github.com/owner/repo"],
    ["git@gitlab.example.org:group/sub/repo.git", "gitlab.example.org/group/sub/repo"],
    ["  github.com/owner/repo  ", "github.com/owner/repo"],
    ["github.com/owner/my.repo", "github.com/owner/my.repo"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeProjectRemote(input)).toEqual(ok(expected));
  });

  it("never echoes a rejected remote back, since it may carry a credential", () => {
    const result = normalizeProjectRemote("https://user:s3cret-token@github.com/owner/repo?x=1");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("s3cret-token");
  });

  it.each([
    [""],
    ["   "],
    ["repo"],
    ["owner/repo"],
    ["github.com/owner"],
    ["github.com"],
    ["localhost/owner/repo"],
    ["/home/me/repo"],
    ["file:///home/me/repo"],
    ["ftp://github.com/owner/repo"],
    ["https://github.com/owner/repo?tab=readme"],
    ["https://github.com/owner/repo#readme"],
    ["github.com/owner/../repo"],
    ["github.com/owner/./repo"],
    ["github.com/owner//repo"],
    ["github.com/own er/repo"],
    ["-bad.com/owner/repo"],
    ["github..com/owner/repo"],
    ["github.com/owner/.git"],
    [`github.com/owner/${"r".repeat(300)}`],
    ["javascript:alert(1)"],
  ])("rejects %j", (input) => {
    expect(normalizeProjectRemote(input).ok).toBe(false);
  });
});
