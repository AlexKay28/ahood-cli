// ahood-cli#262: tests that spawn the built CLI pay a node startup per call,
// and under machine load (busy CI runner, parallel agents) that alone can
// approach vitest's 5s default -- a flake that passes alone and on re-run.
// Applied per file via vi.setConfig rather than in vitest.config.ts so the
// pure unit tests keep the tight default and still catch real hangs fast.
export const SUBPROCESS_TEST_TIMEOUT = 30_000;
