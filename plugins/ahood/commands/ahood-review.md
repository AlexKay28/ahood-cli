---
description: "Review pending self-evolution proposals for your ahood artifacts"
allowed-tools:
  - Bash(npx -y @ahood/cli@0.15.0 review --json)
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Walk the user through their pending ahood evolution proposals.

1. Run `npx -y @ahood/cli@0.15.0 review --json`.
2. For each proposal show the artifact, the proposed change and its evidence (checks, probe verdict, risk findings, why automatic mode held it).
3. Ask approve, reject or skip. Run `npx -y @ahood/cli@0.15.0 review approve <id>` or `npx -y @ahood/cli@0.15.0 review reject <id>` only on the user's explicit decision.

Run each command exactly as written, through `npx -y @ahood/cli@0.15.0` (the CLI release this plugin was built with), not a global `ahood` on PATH, which may be an older release. If a command says you are not logged in, tell the user to run `npx -y @ahood/cli@0.15.0 login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
