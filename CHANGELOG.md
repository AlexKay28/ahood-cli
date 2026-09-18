# Changelog

## Unreleased

- `ahood whoami` now distinguishes an account that is still provisioning (new
  exit code `7`: "Account created -- the registry is still setting it up. This
  finishes on its own; try again in a minute.") from a token the registry has
  no profile for (existing not-found exit code `5`), instead of reporting a
  bare "Authenticated." for both (ahood#340).
