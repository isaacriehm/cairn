---
name: cairn-bootstrap
description: |
  Use when the SessionStart context flagged `bootstrap_required` for
  this clone — the project is cairn-adopted (`.cairn/config.yaml`
  present) but the local clone has not run the per-clone join step
  (no `core.hooksPath` set). Walks the operator through bootstrap
  inline by spawning the bundled `cli.mjs join` subprocess and
  surfacing the result. Skip when the SessionStart banner did not
  include the bootstrap warning.
---

# Skill: cairn-bootstrap

You are bootstrapping a freshly-cloned repo so this developer's local
git hooks point at cairn's per-clone tooling. Bootstrap is **per-clone,
one-time, and silent** — once finished, every commit on this machine
attests through cairn's pre-commit / commit-msg / post-commit hooks.

Refer to `docs/PLUGIN_ARCHITECTURE.md` §17 Layer 4 for the full
bootstrap-banner contract.

## Trigger gate

Before doing anything, verify the SessionStart context included the
`bootstrap_required` warning. If not, exit with no output. The skill
is only meaningful when the SessionStart banner explicitly invited it.

## Step 1 — surface the inline prompt

Render exactly:

> This project uses Cairn, but your clone isn't bootstrapped yet.
> `[a]` bootstrap now — wires git hooks for this clone (~5s)
> `[b]` skip — cairn write surface stays disabled

Use `AskUserQuestion`. Do not preamble; the question is the entire
turn.

- **`[a]`** → continue to Step 2.
- **`[b]`** → end the turn. The MCP write tools will continue to
  refuse with `BOOTSTRAP_REQUIRED`; the operator can re-trigger this
  skill from the next session's banner.

## Step 2 — run the bundled join command

Spawn this Bash command in the repo's working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" join
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's cache dir at runtime;
the bundle is self-contained, so there's no `npm install -g` or `npx`
involved.

Expected stdout pattern:

```
cairn join: bootstrapped
  ✓ git hooks → .cairn/git-hooks
  ✓ post-merge cleanup wired
```

Per-step warnings are non-fatal (e.g. "no .cairn/git-hooks/ — re-run
init"). Surface the full stdout in a fenced ```text``` block so the
operator can review.

## Step 3 — confirm + exit

When the subprocess exits 0:

> Bootstrap complete. Cairn's write surface is unblocked for this
> clone; commits will attest automatically.

When it exits non-zero, surface the failure inline:

> Bootstrap failed at step <X>. `[a]` retry  `[b]` abort + open
> `.cairn/JOIN.md` for manual recovery

## Hard rules

- Never run `cairn join` via `npx` or a globally-installed CLI — the
  plugin owns the bundle path; using anything else risks version
  divergence between the plugin and the join logic.
- Never mention CLI commands like `cairn join` / `cairn doctor` /
  `npx ...` in operator-facing chat output. The skill is the surface;
  the bundle is the implementation.
- Bootstrap is per-clone. Re-running on a clone that's already
  bootstrapped is a no-op (the join command is idempotent).
- Caveman-ultra style for chat replies; full English in any code or
  document the skill writes.
