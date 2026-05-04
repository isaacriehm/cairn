# JOIN — bootstrapping a new clone of this project

This project is harness-adopted. Every developer who touches it must run
harness locally so that decisions, invariants, and sensor results stay in
sync across clones.

If you just cloned, run **one** of the bootstrap paths below before
attempting your first commit. The local pre-commit hook will refuse to run
otherwise; the CI gate on every PR will refuse to merge otherwise.

## Path A — Claude Code users (recommended)

If you opened this project with Claude Code and the harness plugin is
enabled, the SessionStart hook detects an unbootstrapped clone and surfaces
an inline `[a]` bootstrap prompt. Pick `[a]` once and you are done.

If the plugin isn't installed yet:

```bash
# Inside Claude Code
/plugin install harness@devplusllc-harness
```

…then reopen the project. The SessionStart prompt will fire.

## Path B — CLI bootstrap

If you don't use Claude Code, run the CLI command:

```bash
npm install -g @devplusllc/harness   # only if harness isn't already installed
harness join                          # idempotent; safe to re-run
```

`harness join` does three things:

1. Checks the `harness` CLI version is compatible with this project's
   `.harness/config.yaml` `harness_version` constraint.
2. Sets `git config core.hooksPath .harness/git-hooks` on this clone so the
   versioned pre-commit / post-commit / commit-msg hooks run.
3. Creates `.harness/sessions/` for this clone if missing.

## Path C — `package.json` `prepare` (Node projects only)

For Node projects the adoption flow already wires
`prepare: harness join || true` into `package.json`. Running
`npm install` / `pnpm install` runs `harness join` for you. The `|| true`
lets the install succeed even if harness isn't yet on PATH; the failure
surfaces at first commit attempt instead.

## Verifying

```bash
git config --get core.hooksPath
# Expected output: .harness/git-hooks
```

```bash
harness doctor
# Should print: "core.hooksPath = .harness/git-hooks ✓"
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
genuinely want to opt the project out of harness entirely, delete
`.harness/` and the next commit will succeed (no hooks, no CI). That is a
project-level decision, not a per-clone one — discuss with the team first.

## Troubleshooting

- **`harness: command not found`** — install the CLI first via the npm
  command above, or open the project in Claude Code with the plugin.
- **`pre-commit hook failed`** — read the sensor output. The hook never
  fails silently. If you genuinely need to bypass once, `git commit
  --no-verify` works locally but the CI gate on the PR will still block.
- **`harness join` reports a version mismatch** — upgrade your CLI:
  `npm install -g @devplusllc/harness@latest`.
