---
description: "Star an ahood artifact you used, after your yes"
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Star one ahood artifact (the argument, owner/slug; normally one used in this session). Never star without the user's explicit yes.

1. Say what will happen: "This stars <owner/slug> on ahood under your account." Ask for an explicit yes.
2. On yes, run `npx -y @ahood/cli@0.16.0 skill star <owner/slug>`. To undo it later: `npx -y @ahood/cli@0.16.0 skill unstar <owner/slug>`.
3. If the user also wants to leave a note: ahood has no public feedback field yet, so offer `/ahood-snap` with `--artifact <owner/slug>` (private to the user).

Run each command exactly as written, through `npx -y @ahood/cli@0.16.0` (the CLI release this plugin was built with), not a global `ahood` on PATH, which may be an older release. If a command says you are not logged in, tell the user to run `npx -y @ahood/cli@0.16.0 login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
