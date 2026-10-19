# CLAUDE.md

## Paseo embedding (`paseo` branch)

This checkout runs Warp's web build inside Paseo. The `PASEO:` commits on the `paseo` branch and
`paseo-bridge/` exist for that. Whenever you change anything related to it (a `PASEO:` patch,
`paseo-bridge/`, the build command, the bundle Paseo serves), update
`~/projetos/paseo/docs/custom-warp-web-embedded.md` in the same task. Read that doc first.
After committing on `paseo`, back it up with `git push fork paseo` (remote `fork` is
`barruda/warp` through the `github.com-personal` SSH alias; never use the plain `github.com` host).

See `AGENTS.md` for the rest of this repo's guidance.
