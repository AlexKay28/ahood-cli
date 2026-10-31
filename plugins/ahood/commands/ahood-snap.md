---
description: "Capture a private, structured ahood snap of what this session learned"
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Draft a structured snap of this session, show it, and save it only if the user agrees.

1. Draft: one-line summary, plus what failed, what worked, the fix, the lesson, and the ahood artifact it concerns (owner/slug), when known. Leave out anything secret (tokens, keys, private data).
2. Show the draft and ask whether to save it. Snaps are private to the user.
3. On yes: `npx -y @ahood/cli@0.16.0 snap create "<summary>" --failed "<...>" --worked "<...>" --fix "<...>" --lesson "<...>" --artifact <owner/slug>` (omit the flags you have nothing for).

Run each command exactly as written, through `npx -y @ahood/cli@0.16.0` (the CLI release this plugin was built with), not a global `ahood` on PATH, which may be an older release. If a command says you are not logged in, tell the user to run `npx -y @ahood/cli@0.16.0 login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
