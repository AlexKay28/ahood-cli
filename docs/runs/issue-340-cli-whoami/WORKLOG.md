# WORKLOG — issue-340-cli-whoami

Sealed run for ahood issue #340 (CLI half): `ahood whoami` distinguishes a
still-provisioning account from a token with no profile at all.

## Step 1 — Seal

`PYTHONPATH=/home/alexkay28/project/tahoe/src python3 -m tahoe seal docs/runs/issue-340-cli-whoami/program.think`
printed exactly `6d5dd4544e49191099f77a1fcdd8bcb35fbe2a5fbf12bcfcf6f258c8d8af9db4`.
Saved verbatim to `seal.txt`.

## Step 2 — Read the conventions

Read `src/commands/whoami.ts`, `src/exit-code.ts`, `src/http.ts`,
`tests/whoami.test.ts` in full, plus the `checkAuth()` consumer
`src/mcp/tools.ts` (read-only). Conventions observed:

- `checkAuth()` never throws; every failure mode is a return value, and the
  profile fetch is best-effort enrichment that must not break the auth answer.
- `whoami()` maps result variants to prose on stderr (failures) / stdout
  (success), `--json` always on stdout, exit code via `process.exitCode`.
- `exit-code.ts` is a function of thrown errors with inline literals: 2 usage,
  4 auth, 5 not-found (404), 6 network/5xx. **6 is taken**, so the new
  provisioning code is **7** (next free), exported as `EXIT_PROVISIONING`.
- Tests stub global `fetch` with `stubApiRoutes` keyed by pathname; env is
  sandboxed per-test (HOME/AHOOD_TOKEN/AHOOD_API_URL).

## Step 3 — Discover the provisioning field name (not discoverable locally)

`grep -rn provisioning src/ tests/` finds only `src/commands/login.ts:94` (a
comment about the *device-flow* poll being "still-provisioning") — nothing
about the `/api/v1/profile` response shape. The server-side contract
(app/api/v1, ahood repo) is not vendored in this worktree, so **the exact
field name cannot be discovered locally**. Per the task instructions this
falls back to the defensive-shape approach: read a small set of plausible
optional fields (`provisioning`, `provisioning_state`, `provisioning_status`,
`status`, `state`) and fire only on values that *positively assert*
provisioning (`"provisioning"`/`"pending"` strings, or boolean `true` on a
`provisioning*`-named field). A missing profile is the other side of #337's
distinction and maps to 404 on `/api/v1/profile` — the status `exitCodeFor`
already translates to the documented not-found code 5.

## Step 4 — Implement

- `src/exit-code.ts`: add `export const EXIT_PROVISIONING = 7`.
- `src/commands/whoami.ts`: rework `fetchProfile` into `fetchProfileState()`
  returning present / provisioning / missing / unavailable; add optional
  `profileState?: "provisioning" | "missing"` to the authenticated variant of
  `WhoamiResult`; `whoami()` prints the new wordings and exits 7 / 5. All
  other profile failures (500, network blip, 403-on-profile, empty body)
  keep the existing swallow-and-report-authenticated fallback. Happy-path
  prose/JSON untouched.

## Step 5 — Tests

`tests/whoami.test.ts`: two existing tests stubbed `/api/v1/profile` *by
leaving it unstubbed* (404) to mean "fetch fails" — under #340 a 404 is now
the definitive missing-profile signal, so those stubs became explicit 500s to
preserve their transient-failure intent, and the freed 404 slot became the new
missing-profile test. Added: provisioning (string `status` variant and boolean
`provisioning: true` variant), missing (404 → exit 5), legacy-shape fallbacks
(200 without any state field → byte-identical output; 200 with a
non-provisioning `state: "active"` value → no false positive).

`tests/mcp-server.test.ts`: the MCP tool serializes `checkAuth()` verbatim, so
its "whoami reports authenticated:true" test — which left `/api/v1/profile`
404ing — started seeing `profileState: "missing"` in the tool result. Its
intent is the auth-success shape, so the profile stub became a transient 500;
the expected object is unchanged. This file is edited under the task's
`tests/**` grant read as "test files covering whoami response shapes" (this is
the whoami response as surfaced through MCP), noted here rather than silently.

Full-suite state (verified against a stashed pristine tree): 13
`tests/index.test.ts` "built CLI" failures and 5 timing-sensitive
`tests/lockfile*`/`tests/add.test.ts` failures exist identically without these
changes (index needs a built `dist/`; the fs-race tests are load-flaky and
pass in isolation). Everything whoami-touching is green: whoami 17/17,
mcp-server 20/20; `tsc -p tsconfig.json --noEmit` clean. npm env note:
`npm ci` hit the known optional-deps bug (rolldown native binding missing);
fixed with `npm i --no-save @rolldown/binding-linux-x64-gnu@1.2.6` —
package.json/package-lock.json verified untouched via git status.

## Step 6 — Docs

- `README.md`: whoami row in the Account table mentions the distinction;
  exit-codes table documents 5's whoami case and the new 7. No
  "refresh this page" anywhere — terminal wording only.
- `CHANGELOG.md`: created (repo had none) with a single Unreleased entry
  referencing ahood#340.

## Step 7 — Verify and commit

`npm ci` ran in background during implementation (node_modules was missing).
Ran `npm test -- whoami` plus typecheck, then the scoped commit listed in the
task. See `evaluation.json` for the acceptance map.
