---
description: "Publish the artifact in this directory to ahood, after a diff and your yes"
allowed-tools:
  - Bash(npx -y @ahood/cli@0.16.0 stats --json)
  - Bash(npx -y @ahood/cli@0.16.0 try *)
disable-model-invocation: true
---

<!-- Generated from src/setup/templates/ahood-commands.ts by `npm run sync-plugin`; edit that file, not this one. -->

Publish the artifact in the current directory (or the path the user names). Never publish without the user's explicit yes.

1. Find its root file: exactly one of SKILL.md, AGENT.md, server.json, DOC.md, PROJECT.md, LOOP.md or PROMPT.md must be there; its kind follows from it. Check it for secrets (tokens, keys, private data) and stop if any.
2. Owner: the `owner` in `npx -y @ahood/cli@0.16.0 stats --json`. Slug: ask the user (suggest the folder name).
3. If the artifact already exists, run `npx -y @ahood/cli@0.16.0 try <owner/slug>`, show a diff of the published root file against the local one, and suggest the next version (patch for fixes, minor for additions). If it is new, ask for a name and a one-line tagline; the first version is usually 1.0.0.
4. Show exactly what will be published: the directory, kind, owner/slug@version, and the changelog line. Ask for an explicit yes.
5. On yes, run `npx -y @ahood/cli@0.16.0 skill publish <owner/slug>@<version> --path <dir> --changelog "<line>"` (add `--name "<name>" --tagline "<tagline>"` for a new artifact).

Run each command exactly as written, through `npx -y @ahood/cli@0.16.0` (the CLI release this plugin was built with), not a global `ahood` on PATH, which may be an older release. If a command says you are not logged in, tell the user to run `npx -y @ahood/cli@0.16.0 login` in a terminal (it opens a browser) and stop.

User arguments, if any: $ARGUMENTS
