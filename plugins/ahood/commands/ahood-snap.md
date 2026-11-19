---
description: "Capture a private, structured ahood snap of what this session learned"
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Draft a structured snap of this session, show it, and save it only if the user agrees. One snap = one artifact.

1. Find the exact artifact first, if one is involved: `owner/slug` from `npx -y @ahood/cli@0.20.1 status --json` or the MCP tool `list_my_skills` -- the ahood username, never a GitHub handle (a bare slug of your own skill also works). Omit it when the session was not about an ahood artifact.
2. Draft: one-line summary, what failed (concrete: the command or symptom), what worked, the fix, and the lesson -- ONE general imperative rule the artifact should contain ("Always X before Y, because Z"), no names, secrets or private paths. Leave out anything secret (tokens, keys, private data).
3. Show the draft and ask whether to save it. Snaps are private to the user.
4. On yes: `npx -y @ahood/cli@0.20.1 snap create "<summary>" --failed "<...>" --worked "<...>" --fix "<...>" --lesson "<...>" --artifact <owner/slug or slug>` (omit the flags you have nothing for).
5. Read the reply: if it says the artifact is not enabled for evolution or not found, tell the user (they can enable evolution on the artifact's page) or fix the name and retry.

Run each command exactly as written, through `npx -y @ahood/cli@0.20.1` (the CLI release this plugin was built with), not a global `ahood` on PATH, which may be an older release. If a command says you are not logged in, tell the user to run `npx -y @ahood/cli@0.20.1 login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
