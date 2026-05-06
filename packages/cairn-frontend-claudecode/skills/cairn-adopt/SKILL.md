---
name: cairn-adopt
description: One-time Cairn adoption pipeline for a new project.
when_to_use: |
  Use when operator opens Claude Code in project without `.cairn/`
  AND Cairn not declined. Drives one-time adoption inline via
  cairn_init_phase_* MCP tools as state machine — each phase returns
  complete (advance) or needs_input (AskUserQuestion, thread answer,
  re-invoke). Skip when `.cairn/` exists or operator picked "never".
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
Use the **fully-qualified MCP tool names** (the bare `cairn_…` form
silently no-ops in `select:`). `AskUserQuestion` is built-in and stays
unprefixed.

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_init_resume,mcp__plugin_cairn_cairn__cairn_init_phase_1_detect,mcp__plugin_cairn_cairn__cairn_init_phase_2_walker,mcp__plugin_cairn_cairn__cairn_init_phase_3_mapper,mcp__plugin_cairn_cairn__cairn_init_phase_3b_seed,mcp__plugin_cairn_cairn__cairn_init_phase_4_pilot,mcp__plugin_cairn_cairn__cairn_init_phase_5_brand,mcp__plugin_cairn_cairn__cairn_init_phase_6_docs_ingest,mcp__plugin_cairn_cairn__cairn_init_phase_7b_source_comments,mcp__plugin_cairn_cairn__cairn_init_phase_7c_rules_merge,mcp__plugin_cairn_cairn__cairn_init_phase_8_baseline,mcp__plugin_cairn_cairn__cairn_init_phase_10_strip,mcp__plugin_cairn_cairn__cairn_init_phase_12_multidev,mcp__plugin_cairn_cairn__cairn_decision_get,mcp__plugin_cairn_cairn__cairn_resolve_attention,AskUserQuestion)
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

**Contract (v0.3.5):** the phase tools persist `state` to
`.cairn/init-state.json` after every successful return and read it
back on the next call. You do **not** thread state through tool
arguments — phase tools take only an optional `answer` field for
needs_input phases. Tool responses are skinny: `{status, nextPhase}`,
`{status, question}`, or `{status, error}`. **Never** try to read the
on-disk state until the loop has terminated; until then the phase
tools own all writes to it.

**Init the pipeline** by calling `cairn_init_resume` (no args). It
returns `{ status: "ready" | "done", nextPhase: <PhaseId> | null,
repoRoot }`. If `status === "done"` the project is already mid-init or
fully adopted — abort and tell the operator to check
`.cairn/init-state.json`.

**Loop until done**:

```
while nextPhase != null:
    tool_name = `cairn_init_phase_${nextPhase.replace(/-/g, "_")}`
    result = call tool_name({})            # no args; tool reads state from disk
    switch (result.status):
      case "needs_input":
        answer = AskUserQuestion(result.question.prompt, result.question.options)
        # Pass result.question.options.map(o => o.detail) as the
        # AskUserQuestion description field so the operator sees the
        # secondary hint inline with each choice.
        result = call tool_name({ answer: answer.id })
        # second call returns "complete" | "error"; fall through.
      case "complete":
        nextPhase = result.nextPhase
        continue
      case "error":
        surface result.error.message + result.error.detail to operator
        ask via AskUserQuestion: `retry phase` / `abort`
        if "retry phase": continue (state on disk is intact — error path does NOT clobber)
        else: end turn
```

The phase tools persist `state` to `.cairn/init-state.json` after every
successful return so a mid-init `/exit` resumes cleanly on the next
session — the top of this loop just calls `cairn_init_resume` again.

**During each phase**, render a styled status banner BEFORE invoking
the tool. The banner is a markdown horizontal rule + bold phase name +
em-dashed description. This is the operator's primary progress signal
during the long-running phases (3-mapper, 6-docs-ingest, 7b/7c).

Format (one banner per phase, posted as plain assistant text — not as
a tool call):

```markdown
---
**Phase <id>** — <one-line description> · ~<eta>
```

Use this exact phase registry — pick the matching row, substitute the
`<id>`, render. Do NOT improvise descriptions:

| `<id>` | description | eta |
|---|---|---|
| `1-detect` | environment + stack signature scan | <1s |
| `2-walker` | repo summary scan | <1s |
| `3-mapper` | Sonnet domain map (per-module) | ~30-60s |
| `3b-seed` | seed `.cairn/` skeleton + grandfather commits | <1s |
| `4-pilot` | pick seed module | operator |
| `5-brand` | brand auto-fill | operator |
| `6-docs-ingest` | Haiku ingest of README + docs/ → DEC drafts | ~15-30s |
| `7b-source-comments` | classify essay comments → DEC + invariant drafts | ~30s |
| `7c-rules-merge` | merge CLAUDE.md / AGENTS.md sections → drafts | ~45s |
| `8-baseline` | first sensor sweep | <1s |
| `10-strip` | per-module strip-replace consent | operator |
| `12-multidev` | per-host package manager hints | <1s |

When the phase is operator-driven (`<eta>` = `operator`) the
`AskUserQuestion` widget appears immediately after the banner — do NOT
add a third "what would you like to do" line; the widget is the prompt.

**Do not render the phase's question inline** when a phase returns
`needs_input` — `AskUserQuestion` is the only render path;
double-rendering produces the question as scrollback text AND as an
interactive widget.

**Never spawn a subagent to drive the pipeline.** The skill itself is
the orchestrator. Spawning a generic-purpose Agent to run the loop
loses the operator-facing banner channel and burns tokens on a
nested ToolSearch + state re-discovery — adoption stays in this turn.

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

**This step is mandatory and produces a single assistant turn that
contains BOTH a summary text block AND a `Skill` tool call. Do NOT
end the turn with text only — the operator has not seen the pending
DEC drafts yet, and ending here orphans them in `_inbox/`.**

The phase tools persist final state to `.cairn/init-state.json` and
do **not** clear it on terminal completion. Read the persisted state
to source the summary fields:

```bash
jq -c '{
  pilot: .outputs["4-pilot"].picked,
  decs_docs: (.outputs["6-docs-ingest"].decDraftsWritten // [] | length),
  decs_comments: (.outputs["7b-source-comments"].decDraftsWritten // [] | length),
  decs_rules: (.outputs["7c-rules-merge"].decDraftsWritten // [] | length),
  invariants: (.outputs["7b-source-comments"].invariantsWritten // [] | length),
  baseline_findings: (.outputs["8-baseline"].totalFindings // 0),
  multidev_hosts: (.outputs["12-multidev"].hostKinds // [])
}' .cairn/init-state.json
```

In the same assistant message, do both:

1. Emit a tight summary using the values above:

   - Pilot module
   - DEC drafts proposed (sum of `decs_docs + decs_comments + decs_rules`)
   - Invariants seeded into ground state (each entry is a `INV-<NNNN>`
     file already at status `active`)
   - Baseline sensor findings
   - Multi-dev install (host kinds rolled up)

   Use plain operator-facing language. Do **not** say "§INV invariant
   proposals" or other internal-spec jargon — say "invariant rules
   seeded" or "hard constraints logged".

2. Immediately call the `Skill` tool with `skill: "cairn:cairn-attention"`
   to drain pending DEC drafts. The `allowed-tools` line in this skill's
   frontmatter pre-approves that single chained call. The cairn-attention
   skill renders DEC-0001 directly via `AskUserQuestion`; do not surface
   "Now reviewing the N pending DEC drafts…" prose — the next skill's
   prompt is the operator's next surface.

If you emit only the summary text and end the turn, adoption is
incomplete — the operator never gets the chance to accept/reject
drafts. The Skill call is the contract that adoption finished.

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
- Never thread `state` through phase tool arguments. Phase tools read
  state from `.cairn/init-state.json`; the only argument that flows
  back in is `answer` for needs_input phases.
- Never spawn a subagent to drive the pipeline loop. The skill is the
  orchestrator; nested agents lose the banner channel and burn tokens.
- Caveman-ultra style for chat replies; full English in any code or
  document the skill writes.
