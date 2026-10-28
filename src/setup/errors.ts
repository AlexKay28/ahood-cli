// `ahood setup` refused to touch a file: it is malformed, or holds an entry
// with our name that we did not write. Thrown while PLANNING, before any file
// is written, so a refusal always means "nothing was changed".
export class SetupRefusedError extends Error {}
