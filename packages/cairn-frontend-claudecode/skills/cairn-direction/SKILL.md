---
name: cairn-direction
description: Spec-tightener + subagent dispatcher. Engage on code-change asks — verbs, bug reports, observations. Pivot-aware on active tasks.
when_to_use: |
  Engage when operator's message implies code change. Triggers:
    - Task verbs (build, add, fix, refactor, implement, remove, …)
    - Bug reports + symptom observations
    - Modal-verb requests (should, must)
    - Mission continuation tokens ("continue", "go", "next") +
      autonomy phrases ("autonomously", "until ctx", "don't pause")
  Bug reports + observations ARE tasks.

  Skip ONLY:
    - Pure info question with no active mission to continue
    - Operator opted out ("skip cairn", "just do it")
    - Trivial fully-specified edit ("rename foo to bar at f.ts:42")

  Active-task case → Step 0.5 (pivot detection), not skip.
---

# Skill: cairn-direction

Convert loose operator prompts into tightened specs + dispatched
work. Long-form playbooks live in `docs/PLUGIN_ARCHITECTURE.md` §11
(rejection capture, pivot, mission scope, dispatch block,
autonomous continuation) and §14 (question quality). This file is
the entry-point summary.

## Step 0 — preload deferred tools (REQUIRED FIRST)

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_task_create,mcp__plugin_cairn_cairn__cairn_task_complete,mcp__plugin_cairn_cairn__cairn_in_scope,mcp__plugin_cairn_cairn__cairn_canonical_for_topic,mcp__plugin_cairn_cairn__cairn_search,mcp__plugin_cairn_cairn__cairn_mission_get,mcp__plugin_cairn_cairn__cairn_mission_start,mcp__plugin_cairn_cairn__cairn_mission_accept_draft,mcp__plugin_cairn_cairn__cairn_mission_set_exit_gate,mcp__plugin_cairn_cairn__cairn_record_decision,AskUserQuestion)
```

`AskUserQuestion` is deferred — without preload you fall back to
inline prose and break the structured-answer contract.

## Step 0.4 — operator-rejection capture

Operator rejects prior work ("bad", "don't like", "stop using",
"wrong") → capture as draft DEC BEFORE the local fix. Extract regex
+ globs + rationale → dedupe via `cairn_search` →
`cairn_record_decision({..., assertions: [{kind:
"text_must_not_match", pattern, in_globs}]})` (default `target:
"inbox"`) → surface ``Captured rejection → draft `DEC-<id>`
queued.`` Full playbook: `docs/PLUGIN_ARCHITECTURE.md` §11.

## Step 0.5 — pivot detection (active-task path)

`ls .cairn/tasks/active/` empty → Step 0.7.

**Cold-resume.** Continuation token AND `journal.jsonl` has entries
from a different `session_id` → `cairn_resume({task_id})`, read
`files_touched` (cap 8, most-recent-first, parallel), read
`spec.tightened.md`, resume from `next_step`.

Otherwise compare prompt to active title + goal:

- **Same subject** → continue inline, no `cairn_task_create`.
- **Diverging** → `AskUserQuestion`: `[a]` complete first,
  `[b]` abort + pivot, `[c]` fold as sub-task.
  Detail: `docs/PLUGIN_ARCHITECTURE.md` §11.

## Step 0.7 — mission scope detection (no active mission)

`cairn_mission_get({})`. `active: true` → skip (Step 2.5 anchors).

`active: false` → mission-shape signals (2+ must hit): 3+ task
verbs; enumerated phases; 3+ feature nouns from different areas;
scope phrasing ("build the whole X"); >300 words AND 2+ H2/H3.

Trigger → `AskUserQuestion`: `[a]` mission, `[b]` single task. On
`[a]`: write prompt to `.cairn/missions/_drafts/<slug>.md` →
`cairn_mission_start({spec_path, exit_gate: "prompt"})` → surface
phases via second `AskUserQuestion` → `cairn_mission_accept_draft`.
Full flow: `docs/PLUGIN_ARCHITECTURE.md` §11.

## Hard contract — spec MUST exist before mutation

**`.cairn/tasks/active/<task_id>/status.yaml` on disk → tightened,
proceed. Otherwise no `Edit` / `Write` / `NotebookEdit` and no
mutating `Bash`.** Permitted pre-spec: `Read`, `Glob`, `Grep`,
read-only `Bash`, `cairn_*` MCP tools.

"No questions needed" from Step 2 → write the spec NOW with empty
questions; it does NOT skip Step 3.

## Step 1 — gather in-scope context (parallel)

`cairn_in_scope`, `cairn_canonical_for_topic`, `cairn_search`,
`Bash: git log --oneline -5`.

## Step 2 — decide ready vs questions

Ready: every fork resolved by an in-scope decision or no-op. Not
ready: load-bearing fork remains.

`AskUserQuestion` only (never inline prose). ≤3 questions per
call; total rounds unbounded. Cite DEC / §INV / RUN in every
option. Loop Step 1+2 each round. Bar:
`docs/PLUGIN_ARCHITECTURE.md` §14.

## Step 2.5 — mission anchoring (active mission)

`cairn_task_create` auto-stamps `mission_id` + `phase_id` from the
cursor when both omitted. Default: omit.

**Off-mission detection.** Read cursor `phase.title` +
`phase.exit_criteria`. Prompt diverges → `AskUserQuestion`:
`[a]` side-task (`mission_id: ""`), `[b]` fold into phase, `[c]`
advance phase first. Full flow: `docs/PLUGIN_ARCHITECTURE.md` §11.

## Step 2.6 — autonomous mission continuation (vibe-coder mode)

Operator typed `continue` / `go` / autonomy phrase AND mission
active AND no current task → act silently, no `AskUserQuestion`.
Auto-flip `exit_gate: "auto"` on first hit, auto-pick next PR from
`cursor.active_phase_exit_criteria` (regex `\d+\.\d+-[A-Z]+\d+`),
jump to Step 3. Full playbook: `docs/PLUGIN_ARCHITECTURE.md` §11.

Don't trigger on bare `yes` / `ok` / `sure`. Yield only on
ambiguous exit_criteria, subagent failure, or context threshold.

## Step 3 — `cairn_task_create` (ALWAYS, server-enforced)

Only sanctioned write path. Server allocates `task_id`, atomically
writes `spec.tightened.md` + `status.yaml` under
`.cairn/tasks/active/<task_id>/`.

```
cairn_task_create({
  slug, title, goal, module,
  target_path_globs,                       // optional
  in_scope_decisions, in_scope_invariants, // from Step 1
  constraints, out_of_scope, acceptance,
})
```

`slug` 3-80 char kebab; `title` ≤80 chars; `goal` 1-2 sentences;
each `constraints` bullet cites a DEC / §INV. On `TASK_DIR_EXISTS`
retry once; any other error → surface and stop.

## Steps 4-5 — chunk + dispatch

Re-entry guard: `spec.tightened.md` AND `status.yaml` must exist
on disk. If either missing, return to Step 3.

Chunks by file/module boundary. **1 chunk** → implement inline.
**≥2 chunks** → render a 1-line plan review and dispatch via the
block format documented in `docs/PLUGIN_ARCHITECTURE.md` §11:

> Plan: 3 subagents — `[auth]` `[billing]` `[tests]`. `[a]` dispatch  `[b]` modify  `[c]` cancel
> Tightened spec: `.cairn/tasks/active/<task_id>/spec.tightened.md`

If you leave any follow-up in source for this task, drop
`// TODO(TSK-<task_id>)` on the line — bare `TODO` doesn't resolve.

## Comment policy when citing DEC / INV

Cite alone. `cairn_invariant_get` / `cairn_decision_get` dereference
the cite; frontmatter `title:` is the canonical phrase.

```ts
// §INV-7086201                            // default — terse marker
// §INV-7086201 (SSR cache, params block)  // allowed: one short clause
                                           // only when the cite alone
                                           // is ambiguous
```

Never restate the body or prepend `// AI:`. Restating the title
(`// AI: §INV-7086201 — Query key must match …`) is the anti-pattern
— the prose duplicates the frontmatter and rots when it's edited.

## Hard rules

- `AskUserQuestion` ≤3 questions per call; cite DEC / §INV / RUN
  in every option. Never inline prose.
- **Self-attest.** Close tasks with
  `cairn_task_complete({outcome, summary})` — summary IS the
  attestation (1-2 paragraphs). Reviewer subagent is opt-in.
- **Don't mirror Stop-hook surfaces** (stalled tasks, unattested
  commits, ctx-threshold, phase-exit).
- **Honor autonomy intent.** Autonomy phrase OR mission
  `exit_gate: "auto"` → suppress non-blocking `AskUserQuestion`.
- Populate `in_scope_decisions` + `in_scope_invariants` whenever
  Step 1 named matches.
- Chat voice from `.cairn/ground/brand/voice.md` when present;
  spec file content is full English.
