---
description: Adopt this project with harness — runs the one-time init pipeline inline.
---

# /harness-init

Manually trigger the harness adoption flow. Equivalent to the
`harness-adopt` skill, but invoked explicitly by the operator.

Useful when:

- The operator previously declined `[c]` "never" and wants to retry.
- The operator skipped `[b]` "not now" and the 7-day re-prompt window
  hasn't elapsed yet.
- The operator wants to re-adopt after deleting `.harness/` (e.g.
  starting fresh from a known baseline).

## Behavior

Invoke the `harness-adopt` skill. It owns the trigger gate, preflight,
init subprocess, and the phase-by-phase A/B/C surface.

If `.harness/` already exists, the skill detects this and surfaces:

> Project is already harness-adopted. `[a]` re-run init (`harness init --force`, may overwrite ground state)  `[b]` doctor (verify health)  `[c]` cancel

Default to `[c]` cancel for safety.
