import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // ahood-cli#124: tests used to hand-roll these resets, inconsistently, so a
    // `.not.toHaveBeenCalled()` assertion could pass or fail depending on what ran
    // before it. Both flags stay, but they do DIFFERENT jobs -- don't drop one
    // because the suite is still green without it:
    //
    // clearMocks is the one the suite currently depends on. restoreAllMocks()
    // only walks the spies vi.spyOn registered, so it never reaches the bare
    // vi.fn()s created inside vi.mock factories (promptSecret, withLock);
    // clearAllMocks() is what wipes THEIR call history, and it leaves
    // implementations alone so the factory defaults survive. Removing it fails
    // 8 tests in add/mcp-lifecycle.
    //
    // restoreMocks covers what clearMocks cannot: mockClear keeps a spy's
    // implementation installed, so without it a `vi.spyOn(console, "log")
    // .mockImplementation(() => {})` stays on console.log for every later test
    // in the file. The suite passes without it today only because the affected
    // tests all re-spy anyway -- it's guarding the next test that doesn't.
    //
    // mockReset is deliberately off: it discards implementations rather than
    // just history, and the module-factory pass-throughs survive it only via a
    // version-dependent vitest nicety. Bigger hammer than the problem needs.
    restoreMocks: true,
    clearMocks: true,
  },
});
