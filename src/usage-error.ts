// Thrown for a usage/validation error caught locally, before any network
// call -- a missing/malformed argument, an invalid flag value, a bad
// owner/skill spec, etc. Kept distinct from a plain Error so exit-code.ts's
// exitCodeFor() can map it to exit code 2 ("usage or validation error", per
// the README's exit-code table) instead of falling through to the generic 1
// ("general error") that every other thrown Error gets (ahood-cli#80).
export class UsageError extends Error {}
