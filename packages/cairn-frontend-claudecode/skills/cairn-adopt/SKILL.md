---
name: cairn-adopt
description: One-time Cairn adoption pipeline for a new project.
when_to_use: |
  Use when the operator opens Claude Code in a project that does not yet
  have a `.cairn/` directory and Cairn has not been declined for this
  project. Walks the operator through one-time adoption inline by
  driving the cairn_init_phase_* MCP tools as a state machine — each
  phase result is either complete (advance) or needs_input (render
  AskUserQuestion, thread the answer back, re-invoke). Skip when
  `.cairn/` already exists or when the operator selected "never" for
  this project.
allowed-tools: Skill(cairn:cairn-attention)
---

# Skill: cairn-adopt

You are guiding the operator through one-time Cairn adoption for the
current project. Adoption is **visual, comprehensive, and one-time** —
once finished, Cairn runs invisibly forever. Refer to
`docs/PLUGIN_ARCHITECTURE.md` §6 for the canonical phase sequence.

## Step 0 — preload tools

Open the skill with **one** `ToolSearch` call that batch-loads every
deferred tool the loop needs. This avoids one round-trip per phase.

```
ToolSearch(select:cairn_init_resume,cairn_init_phase_1_detect,cairn_init_phase_2_walker,cairn_init_phase_3_mapper,cairn_init_phase_3b_seed,cairn_init_phase_4_pilot,cairn_init_phase_5_brand,cairn_init_phase_6_docs_ingest,cairn_init_phase_7b_source_comments,cairn_init_phase_7c_rules_merge,cairn_init_phase_8_baseline,cairn_init_phase_10_strip,cairn_init_phase_12_multidev,cairn_decision_get,cairn_resolve_attention,AskUserQuestion)
```

After this single call all phase tools + the question tool + the
attention resolver are loaded for the rest of the skill.

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

## Step 1 — propose adoption

Call `AskUserQuestion` directly with the three options:

- **`yes`** — walk adoption now (~30-60s, streamed)
- **`not now`** — ask again next session
- **`never for this project`** — mark opted-out

Do not preamble. Do not render the question as inline markdown — the
`AskUserQuestion` UI is the canonical render path.

- **`yes`** → continue to Step 2.
- **`not now`** → record `decline-temp` in `projects.json` (re-prompt
  after 7 days) and end the turn.
- **`never for this project`** → record `decline-never` in `projects.json`
  and end the turn.

## Step 2 — preflight

Run the deterministic preflight check:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || true
```

If the directory is not a git working tree, surface a one-line note +
`AskUserQuestion` (`init git repo` / `abort`). On `init git repo`,
run `git init` then continue. On `abort`, end the turn.

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
        # Pass result.question.options.map(o => o.detail) as the
        # AskUserQuestion description field so the operator sees the
        # secondary hint inline with each choice.
        state = { ...result.state, answer: answer.id }
        # re-invoke the same phase tool with the answer threaded in
        continue
      case "complete":
        state = result.state
        nextPhase = result.nextPhase
        continue
      case "error":
        surface result.error.message + result.error.detail to operator
        ask via AskUserQuestion: `retry phase` / `abort`
        if "retry phase": continue with same state
        else: end turn
```

The phase tools persist `state` to `.cairn/init-state.json` after every
return so a mid-init `/exit` resumes cleanly on the next session — the
top of this loop just calls `cairn_init_resume` again.

**During each phase**, surface a one-line status update before invoking
the tool ("Phase 3-mapper — Sonnet domain map, ~30s") so the operator
sees progress. **Do not render the phase's question inline** when a
phase returns `needs_input` — `AskUserQuestion` is the only render
path; double-rendering produces the question as scrollback text AND
as an interactive widget.

## Step 4 — auto-bootstrap the just-adopted clone

When the loop exits with `nextPhase === null`, the on-disk `.cairn/`
state is complete but `core.hooksPath` is still unset on this clone.
Run bootstrap silently — the operator just consented to adoption,
so there is no separate consent gate for the per-clone wiring:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" join
```

The `cairn join` step is idempotent; expected output is two-three
lines confirming hooks-path + chmod + `.cli-path`. Surface nothing
if it succeeds; on failure, surface the stderr + `AskUserQuestion`
(`retry bootstrap` / `skip`).

## Step 5 — final summary + hand off to attention

Render a tight summary sourced from `state.outputs`:

- Pilot module (`outputs["4-pilot"].picked`)
- DEC drafts proposed (count from `outputs["6-docs-ingest"]` +
  `outputs["7b-source-comments"]` + `outputs["7c-rules-merge"]`)
- Invariant rules seeded (count from
  `outputs["7b-source-comments"].invariantProposalsAdded`)
- Baseline sensor findings (`outputs["8-baseline"].totalFindings`)
- Multi-dev install (`outputs["12-multidev"].steps` rolled up)

Use plain operator-facing language. Do **not** say "§V invariant
proposals" or other internal-spec jargon — say "invariant rules
seeded" or "hard constraints logged".

Then invoke the `cairn-attention` skill (the `allowed-tools` line in
this skill's frontmatter pre-approves that single chained call) to
drain any pending DEC drafts. Do not surface "Now reviewing the N
pending DEC drafts…" prose — the next skill's prompt is the operator's
next surface.

If a phase returned `error` and the operator chose `abort`, the state
file persists at `.cairn/init-state.json`; the next session's
SessionStart banner re-prompts to resume.

## Hard rules

- Never skip the trigger gate. A second-pass adoption on an already-
  adopted project corrupts ground state.
- Never write to `.cairn/ground/` from this skill. The phase tools
  own those writes (under the per-write flock).
- Never auto-resolve hard inconsistencies. Every conflict surfaces as
  AskUserQuestion; the operator picks.
- Comment-strip (Phase 10) requires per-module-batch consent. Default
  to surface, never silently strip.
- Never reference `npx ...`, `cairn <subcommand>`, or any CLI from
  the operator-facing chat output. Surface only AskUserQuestion
  prompts and one-line status updates.
- Never render an inline `[a]/[b]/[c]` blockquote for a question that
  also goes through `AskUserQuestion`. Pick one render path.
- Caveman-ultra style for chat replies; full English in any code or
  document the skill writes.
