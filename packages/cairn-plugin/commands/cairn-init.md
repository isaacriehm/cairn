---
description: Adopt this project with Cairn — runs the one-time init pipeline inline.
argument-hint: "[--force]"
---

# /cairn:cairn-init

Manually trigger the Cairn adoption flow. Equivalent to the
`cairn-adopt` skill, but invoked explicitly by the operator.

Useful when:

- The operator previously declined `[c]` "never" and wants to retry.
- The operator skipped `[b]` "not now" and the 7-day re-prompt window
  hasn't elapsed yet.
- The operator wants to re-adopt after deleting `.cairn/` (e.g.
  starting fresh from a known baseline).

## Behavior

Invoke the `cairn-adopt` skill. It owns the trigger gate, preflight,
init subprocess, and the phase-by-phase A/B/C surface.

If `.cairn/` already exists, the skill detects this and surfaces:

> Project is already Cairn-adopted. `[a]` re-run init (warning: may overwrite ground state)  `[b]` doctor (verify health)  `[c]` cancel

Default to `[c]` cancel for safety.
