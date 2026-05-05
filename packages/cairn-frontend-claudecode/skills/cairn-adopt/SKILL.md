---
name: cairn-adopt
description: |
  Use when the operator opens Claude Code in a project that does not yet
  have a `.cairn/` directory and Cairn has not been declined for
  this project. Walks the operator through one-time adoption inline by
  driving the cairn_init_phase_* MCP tools as a state machine — each
  phase result is either a complete (advance) or needs_input (render
  AskUserQuestion, thread the answer back, re-invoke). Skip when
  `.cairn/` already exists, or when the operator has previously
  selected "never" for this project.
---

# Skill: cairn-adopt

You are guiding the operator through one-time Cairn adoption for the
current project. Adoption is **visual, comprehensive, and one-time** —
once finished, Cairn runs invisibly forever. Refer to
`docs/PLUGIN_ARCHITECTURE.md` §6 for the canonical phase sequence.

## Trigger gate

Before doing anything else, verify the trigger conditions:

1. The current project root has no `.cairn/` directory. Use the `Bash`
   tool with `ls .cairn 2>/dev/null` (or read the SessionStart context
   — if it included `cairn state` the project is already adopted and
   this skill must abort).
2. The operator has not previously declined adoption "forever" for this
   project. Check `${CLAUDE_PLUGIN_DATA}/projects.json` if present;
   abort if `decline-never` is recorded for the current absolute repo
   path.

If either gate fails, exit immediately with no output.

## Step 1 — propose adoption inline

Render exactly:

> Adopt this project with Cairn? `[a]` yes  `[b]` not now  `[c]` never (mark and skip on future opens)

Then call the `AskUserQuestion` tool with those three options as
labels. Do not preamble; the question is the entire turn.

- **`[a]`** → continue to Step 2.
- **`[b]`** → record `decline-temp` in `projects.json` (re-prompt after
  7 days) and end the turn.
- **`[c]`** → record `decline-never` in `projects.json` and end the
  turn. Operator can re-trigger by typing `/cairn-init`.

## Step 2 — preflight

Run the deterministic preflight check:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || true
```

If the directory is not a git working tree, surface inline:

> Cairn needs a git repo. Initialize one now? `[a]` yes  `[b]` no, abort

`[a]` → run `git init` then continue. `[b]` → end the turn.

The Claude binary is no longer required for adoption — the bundled
plugin includes everything cairn needs. Do not check for `claude`
on PATH.

## Step 3 — drive the phase pipeline

This is a state-machine loop against the `cairn_init_*` MCP tools.

**Init the pipeline** by calling `cairn_init_resume` (no args). It
returns `{ status: "ready" | "done", nextPhase: <PhaseId> | null,
state: PhaseState }`. If `status === "done"` the project is already
mid-init or fully adopted — abort and tell the operator to check
`.cairn/init-state.json`.

**Loop until done**:

```
while nextPhase != null:
    tool_name = `cairn_init_phase_${nextPhase.replace(/-/g, "_")}`
    result = call tool_name({ state })
    switch (result.status):
      case "needs_input":
        answer = AskUserQuestion(result.question.prompt, result.question.options)
        state = { ...result.state, answer: answer.id }
        # re-invoke the same phase tool with the answer threaded in
        continue
      case "complete":
        state = result.state
        nextPhase = result.nextPhase
        continue
      case "error":
        surface result.error.message + result.error.detail to operator
        ask: `[a]` retry the same phase  `[b]` abort
        if "a": continue with same state
        else: end turn
```

The phase tools persist `state` to `.cairn/init-state.json` after every
return so a mid-init `/exit` resumes cleanly on the next session — the
top of this loop just calls `cairn_init_resume` again.

**During each phase**, surface a one-line status update before invoking
the tool ("Phase 3-mapper — Sonnet domain map, ~30s") so the operator
sees progress. Do not stream stdout; the tools are MCP-native and emit
no terminal output.

## Step 4 — final summary

When the loop exits with `nextPhase === null`, render a tight summary
sourced from `state.outputs`:

- Pilot module (`outputs["4-pilot"].picked`)
- DEC drafts proposed (count from `outputs["6-docs-ingest"]` +
  `outputs["7b-source-comments"]` + `outputs["7c-rules-merge"]`)
- §V invariants seeded (count from `outputs["7b-source-comments"]`)
- Baseline sensor findings (`outputs["8-baseline"].totalFindings`)
- Multi-dev install (`outputs["12-multidev"].steps` rolled up)

Then auto-invoke the `cairn-attention` skill if any DEC drafts were
written. Do **not** instruct the operator to type `cairn attention` /
`cairn doctor` / `cairn configure brand` — the plugin owns those
flows; the skill just calls the next one.

If a phase returns `error` and the operator picks `[b]` abort, the
state file persists at `.cairn/init-state.json`; the next session's
SessionStart banner can re-prompt to resume.

## Hard rules

- Never skip the trigger gate. A second-pass adoption on an already-
  adopted project corrupts ground state.
- Never write to `.cairn/ground/` from this skill. The phase tools
  own those writes (under the per-write flock).
- Never auto-resolve hard inconsistencies. Every conflict surfaces as
  A/B/C; the operator picks.
- Comment-strip (Phase 10) requires per-module-batch consent. Default
  to surface, never silently strip.
- Never reference `npx ...`, `cairn <subcommand>`, or any CLI from
  the operator-facing chat output. Surface only A/B/C choices and
  one-line status updates.
- Caveman-ultra style for chat replies; full English in any code or
  document the skill writes.
