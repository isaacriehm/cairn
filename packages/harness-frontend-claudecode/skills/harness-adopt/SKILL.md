---
name: harness-adopt
description: |
  Use when the operator opens Claude Code in a project that does not yet
  have a `.harness/` directory and harness has not been declined for
  this project. Walks the operator through one-time adoption inline,
  orchestrates the `harness init` pipeline as a subprocess, and surfaces
  every phase choice as A/B/C inside the conversation. Skip when
  `.harness/` already exists, or when the operator has previously
  selected "never" for this project.
---

# Skill: harness-adopt

You are guiding the operator through one-time harness adoption for the
current project. Adoption is **visual, comprehensive, and one-time** —
once finished, harness runs invisibly forever. Refer to
`docs/PLUGIN_ARCHITECTURE.md` §6 for the canonical phase sequence.

## Trigger gate

Before doing anything else, verify the trigger conditions:

1. The current project root has no `.harness/` directory. Use the `Bash`
   tool with `ls .harness 2>/dev/null` (or read the SessionStart context
   — if it included `harness state` the project is already adopted and
   this skill must abort).
2. The operator has not previously declined adoption "forever" for this
   project. Check `${CLAUDE_PLUGIN_DATA}/projects.json` if present;
   abort if `decline-never` is recorded for the current absolute repo
   path.

If either gate fails, exit immediately with no output.

## Step 1 — propose adoption inline

Render exactly:

> Adopt this project with harness? `[a]` yes  `[b]` not now  `[c]` never (mark and skip on future opens)

Then call the `AskUserQuestion` tool with those three options as
labels. Do not preamble; the question is the entire turn.

- **`[a]`** → continue to Step 2.
- **`[b]`** → record `decline-temp` in `projects.json` (re-prompt after
  7 days) and end the turn.
- **`[c]`** → record `decline-never` in `projects.json` and end the
  turn. Operator can re-trigger by typing `/harness-init`.

## Step 2 — preflight

Run the deterministic preflight checks before launching the heavy init:

```bash
which claude || true
which git || true
git rev-parse --is-inside-work-tree 2>/dev/null || true
```

If `claude` is missing, abort with the install instructions block from
PLUGIN_ARCHITECTURE §16 — adoption requires the Claude binary, no
degraded mode.

If the directory is not a git working tree, surface inline:

> harness needs a git repo. Initialize one now? `[a]` yes  `[b]` no, abort

`[a]` → run `git init` then continue. `[b]` → end the turn.

## Step 3 — launch the init pipeline

Spawn `harness init` as a Bash subprocess. Stream its rich terminal
output (chalk + ora + cli-progress) verbatim into the conversation
inside a fenced ```` ```text ```` block so the operator sees every
phase progress. The init pipeline owns Phases 1–13 of §6 — submodule
detect, priority walk, per-module Sonnet calls, pilot module pick,
brand setup, ground skeleton, docs ingestion (7a), source-comment
ingestion (7b), project-rules merge (7c), baseline sensor audit,
inconsistency detection, comment policy enforcement (10), and CI
gate install (12).

When the init pipeline pauses for an A/B/C choice (it emits a
recognizable sentinel line), translate it into an `AskUserQuestion`
call with the same labels and forward the operator's pick back into
the subprocess via stdin.

## Step 4 — final summary

When init exits 0, summarize in one short message:

- Pilot module
- DEC drafts proposed (count + link to `harness attention`)
- §V invariants seeded
- Baseline sensor findings (count)
- CI workflow + git hooks installed (yes/no)

Then suggest:

> harness is now active. Pending review: N items. `[a]` review now (`harness attention`)  `[b]` later

If init exits non-zero, surface the failure phase and exit code, then
ask:

> Adoption failed at phase X. `[a]` retry  `[b]` abort + diagnose with `harness doctor`

## Hard rules

- Never skip the trigger gate. A second-pass adoption on an already-
  adopted project corrupts ground state.
- Never write to `.harness/ground/` from this skill. The init
  subprocess owns those writes (under the per-write flock).
- Never auto-resolve hard inconsistencies. Every conflict surfaces as
  A/B/C; the operator picks.
- Comment-strip (Phase 10) requires per-module-batch consent. Default
  to surface, never silently strip.
- Caveman-ultra style for chat replies; full English in any code or
  document the skill writes.
