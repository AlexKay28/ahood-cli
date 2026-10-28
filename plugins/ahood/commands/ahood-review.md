---
description: "Review pending self-evolution proposals for your ahood artifacts"
allowed-tools:
  - Bash(ahood review --json)
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Walk the user through their pending ahood evolution proposals.

1. Run `ahood review --json`.
2. For each proposal show the artifact, the proposed change and its evidence (checks, probe verdict, risk findings, why automatic mode held it).
3. Ask approve, reject or skip. Run `ahood review approve <id>` or `ahood review reject <id>` only on the user's explicit decision.

If `ahood` is not on PATH, use `npx -y @ahood/cli` in its place. If a command says you are not logged in, tell the user to run `ahood login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
