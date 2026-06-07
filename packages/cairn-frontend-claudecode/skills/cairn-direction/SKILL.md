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
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_task_create,mcp__plugin_cairn_cairn__cairn_task_complete,mcp__plugin_cairn_cairn__cairn_in_scope,mcp__plugin_cairn_cairn__cairn_canonical_for_topic,mcp__plugin_cairn_cairn__cairn_search,mcp__plugin_cairn_cairn__cairn_mission_get,mcp__plugin_cairn_cairn__cairn_mission_start,mcp__plugin_cairn_cairn__cairn_mission_accept_draft,mcp__plugin_cairn_cairn__cairn_mission_plan_phase,mcp__plugin_cairn_cairn__cairn_mission_advance,mcp__plugin_cairn_cairn__cairn_mission_set_exit_gate,mcp__plugin_cairn_cairn__cairn_record_decision,AskUserQuestion)
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

`active: false` → **always run the complexity check** — this is not
opt-in. Cairn proposes a mission whenever the work is too big for one
task; the operator never has to ask for it.

**Strong triggers (ANY one fires the prompt):**

- Enumerated phases / steps ("first … then …", a numbered list of
  deliverables).
- Scope phrasing — "build the whole / entire X", "redesign Y
  end-to-end", "rewrite Z", "from scratch".
- The prompt points at a spec/planning doc (a `.md` path, a pasted
  PRD, >300 words with 2+ H2/H3 sections).

**Weak signals (2+ together fire the prompt):** 3+ distinct task
verbs; 3+ feature nouns from different areas/modules; cross-cutting
work spanning 3+ modules; an estimate the work needs multiple
sittings.

When nothing fires, proceed as a single task — but if you are about
to create a task whose `goal` spans 3+ modules or whose acceptance
has 4+ independent bullets, stop and run this check first.

Trigger → `AskUserQuestion`: `[a]` mission (recommended for the
listed scope), `[b]` single task. On `[a]`: write prompt to
`.cairn/missions/_drafts/<slug>.md` →
`cairn_mission_start({spec_path, exit_gate: "prompt"})` → surface
phases via second `AskUserQuestion` → `cairn_mission_accept_draft`.
The first phase lands brief-pending → Step 2.55 tightens it before
any task. Full flow: `docs/PLUGIN_ARCHITECTURE.md` §11.

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

## Step 2.55 — per-phase brief gate (active mission, JIT tightening)

Runs whenever a mission is active AND you are about to create a
phase-anchored task. Read `cursor.active_phase_brief_status` from the
`cairn_mission_get` response.

- `accepted` → phase already tightened. Read `cursor.active_phase_brief`
  and fold its `constraints` + `acceptance` + cites into the
  `cairn_task_create` call (Step 3). Skip the rest of 2.55.
- `drafted` → a brief exists but isn't locked. Surface it for
  confirmation, then continue.
- `null` (brief-pending) → tighten THIS phase now, before any task:

**1. Gather phase-scoped context (parallel).** `cairn_canonical_for_topic`
+ `cairn_in_scope` for the phase's topic; read the phase
`exit_criteria` + the spec slice for this phase (the resume tool's
phase section, or the `spec.md` heading matching the phase title).

**2. Find load-bearing forks NOT already resolved by ground state.**
Same bar as Step 2 (§14): a fork is resolved when an in-scope DEC /
§INV / prior-phase brief answers it. List only the unresolved ones.

**3a. No unresolved forks → silent accept.** Call
`cairn_mission_plan_phase({ status: "accepted", decisions: [],
constraints: [<phase rules cited from ground state>], acceptance:
[<exit_criteria refined>], cite_decisions, cite_invariants })`.
Surface one line: `` Phase `<title>` — ground state covers it, no
questions. `` Continue to Step 3.

**3b. Unresolved forks → ask, then lock.** `AskUserQuestion` (≤3 per
call, cite DEC / §INV in every option, loop rounds as needed). Then
`cairn_mission_plan_phase({ decisions: [{question, choice,
rationale}], constraints, acceptance, cite_decisions, cite_invariants
})` (defaults `status: "accepted"`). Surface: `` Phase `<title>`
tightened → brief locked. ``

**Autonomy override.** Mission `exit_gate: "auto"` OR an autonomy
phrase is in play → do NOT prompt. Resolve the forks yourself from
ground state + best judgement and call `cairn_mission_plan_phase({...,
autonomous: true, status: "accepted"})`. The brief records what you
chose so the operator can audit it later.

The brief's `constraints` + `acceptance` flow into every
`cairn_task_create` in this phase — that is how per-phase tightening
reaches the work. Re-read `active_phase_brief` on each new task in the
phase; do not re-run the gate once `brief_status: accepted`.

## Step 2.6 — autonomous mission continuation (vibe-coder mode)

Operator typed `continue` / `go` / autonomy phrase AND mission
active AND no current task → act silently, no `AskUserQuestion`.
Auto-flip `exit_gate: "auto"` on first hit, auto-pick next PR from
`cursor.active_phase_exit_criteria` (regex `\d+\.\d+-[A-Z]+\d+`).
If `active_phase_brief_status` is `null`, run Step 2.55's autonomy
override (self-resolve the brief, `autonomous: true`) BEFORE the
task — never skip phase tightening, only its prompting. Then jump to
Step 3. Full playbook: `docs/PLUGIN_ARCHITECTURE.md` §11.

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

**Inherit the phase brief.** On a mission-anchored task, merge the
accepted brief (`cursor.active_phase_brief` from Step 2.55) into this
call: its `constraints` join `constraints`, its `acceptance` joins
`acceptance`, its `cite_decisions` / `cite_invariants` join
`in_scope_decisions` / `in_scope_invariants`. The phase brief is the
task's inherited spine — task-specific constraints layer on top.

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
