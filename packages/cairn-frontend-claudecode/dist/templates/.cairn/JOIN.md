# JOIN — bootstrapping a new clone of this project

This project is Cairn-adopted. Every developer who touches it must run
Cairn locally so that decisions, invariants, and sensor results stay in
sync across clones.

If you just cloned, run **one** of the bootstrap paths below before
attempting your first commit. The local pre-commit hook will refuse to run
otherwise; the CI gate on every PR will refuse to merge otherwise.

## Path A — Claude Code users (recommended)

If you opened this project with Claude Code and the Cairn plugin is
enabled, the SessionStart hook detects an unbootstrapped clone and surfaces
an inline `[a]` bootstrap prompt. Pick `[a]` once and you are done.

If the plugin isn't installed yet, register the marketplace once and
install:

```bash
# Inside Claude Code
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
```

…then reopen the project. The SessionStart prompt will fire.

## Path B — CLI bootstrap

If you don't use Claude Code, run the CLI command:

```bash
npm install -g @isaacriehm/cairn   # only if Cairn isn't already installed
cairn join                          # idempotent; safe to re-run
```

`cairn join` does three things:

1. Checks the `cairn` CLI version is compatible with this project's
   `.cairn/config.yaml` `cairn_version` constraint.
2. Sets `git config core.hooksPath .cairn/git-hooks` on this clone so the
   versioned pre-commit / post-commit / commit-msg hooks run.
3. Creates `.cairn/sessions/` for this clone if missing.

## Verifying

```bash
git config --get core.hooksPath
# Expected output: .cairn/git-hooks
```

```bash
cairn doctor
# Should print: "core.hooksPath = .cairn/git-hooks ✓"
```

## Why this is required

Without bootstrap:

- **Local commits** — pre-commit hook isn't on the path; you can commit code
  that violates project decisions or invariants.
- **PR merges** — CI gate catches it but the round-trip is wasteful.
- **MCP write tools** — the Claude Code plugin enters degraded mode (read-
  only) and refuses to record DECs from your clone, because there's no
  attestation layer to flag bypassed commits.

The bootstrap step is one-time per clone and takes < 5 seconds. If you
genuinely want to opt the project out of Cairn entirely, delete
`.cairn/` and the next commit will succeed (no hooks, no CI). That is a
project-level decision, not a per-clone one — discuss with the team first.

## Troubleshooting

- **`cairn: command not found`** — install the CLI first via the npm
  command above, or open the project in Claude Code with the plugin.
- **`pre-commit hook failed`** — read the sensor output. The hook never
  fails silently. If you genuinely need to bypass once, `git commit
  --no-verify` works locally but the CI gate on the PR will still block.
- **`cairn join` reports a version mismatch** — upgrade your CLI:
  `npm install -g @isaacriehm/cairn@latest`.
