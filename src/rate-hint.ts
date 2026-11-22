// ahood#1640: after a successful `add` or `read`, one dim line pointing at
// `vote`. Human output on a terminal only: never with --json, never when
// stdout is piped (the content of `read` is often piped into a file). It goes
// to stderr so it can never end up inside captured content.
export function printRateHint(kind: string, owner: string, slug: string): void {
  if (!process.stdout.isTTY) return;
  const line = `Rate it after use: ahood ${kind} vote ${owner}/${slug} up|down`;
  console.error(process.env.NO_COLOR ? line : `\x1b[2m${line}\x1b[0m`);
}
