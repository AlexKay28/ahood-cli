// Thrown when a command names an artifact that has no local install to act
// on (`remove`, `pin`/`unpin`, an explicitly named `update` target). The same
// condition used to exit 0, 1 or 2 depending on the command, so a script
// could not tell "you named something that isn't here" from success or from
// a malformed argument (ahood-cli#255). Its own class, not a UsageError: the
// arguments are well-formed -- the thing they name is absent, which is exit
// code 5's "not found" whether the lookup was the registry's or this
// machine's.
export class NotInstalledError extends Error {}
