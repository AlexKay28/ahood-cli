---
description: "Your ahood artifacts: downloads, stars, recent activity, evolution counts"
allowed-tools:
  - Bash(npx -y @ahood/cli@0.15.0 stats --json)
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Show the user how their published ahood artifacts are doing.

1. Run `npx -y @ahood/cli@0.15.0 stats --json`.
2. Show the totals (artifacts, downloads, stars), a table of their artifacts by downloads (owner/slug, kind, visibility, downloads, stars), the last few activity lines, and the evolution counts (artifacts evolving, proposals waiting; offer `/ahood-review` when any wait).
3. Install trends and evolution yield are not available from the CLI: point at https://www.ahood.dev/my-evolution.

Run each command exactly as written, through `npx -y @ahood/cli@0.15.0` (the CLI release this plugin was built with), not a global `ahood` on PATH, which may be an older release. If a command says you are not logged in, tell the user to run `npx -y @ahood/cli@0.15.0 login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
