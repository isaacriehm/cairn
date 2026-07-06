---
description: Resume an active Cairn task after `/clear`. Reads the task journal + spec and primes context cold.
argument-hint: <task_id>
---

# /cairn:cairn-resume

You are resuming a Cairn task in a fresh-context session. The
operator just `/clear`ed mid-task and pasted this command to rebuild
state. The argument is the `task_id` (format: `TSK-<slug>-<7-hex>`)
or omitted (defaults to the most-recently-touched active task).

## Step 1 — preload tools

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_resume,mcp__plugin_cairn_cairn__cairn_mission_resume,mcp__plugin_cairn_cairn__cairn_in_scope,mcp__plugin_cairn_cairn__cairn_decision_get,mcp__plugin_cairn_cairn__cairn_invariant_get)
```

## Step 1.5 — mission frame (when an active mission exists)

Call `cairn_mission_resume({})` first. If `active: true`, render the
returned `body` verbatim BEFORE the task resume block — it's the
mission-level context (cursor phase + exit_criteria, last 3
graduated tasks across the mission, in-flight tasks under the
cursor, the spec.md slice for the current phase, next 1-2 upcoming
phases). Combined with the task frame from Step 2, total prime
budget is ≤2500 tokens.

If `active: false`, skip this step entirely — the operator is on a
non-mission task and the task journal alone primes the session.

## Step 2 — fetch the resume payload

Call `cairn_resume`. If the operator passed a task_id argument, pass
it through; otherwise omit and let Cairn pick the most-recent active
task:

```jsonc
cairn_resume({ task_id: "<task_id>" })  // or {} if no arg supplied
```

The tool returns:

```jsonc
{
  ok: true,
  task_id: "TSK-…",
  scope: "active" | "done",      // see Step 2.5
  completed_at: "<ISO-8601>" | null,
  title: "<spec H1>",
  goal: "<spec ## Goal section>",
  in_scope_decisions: ["DEC-…"],
  in_scope_invariants: ["INV-…"],
  target_path_globs: ["…"],
  recent_entries: [
    { ts, session_id, summary, next_step?, files_touched?, decisions_loaded? }
  ],
  next_step: "<last entry's next_step or null>",
  total_entries: <number>,
  files_touched: ["<repo-rel path>", …]   // deduplicated union across recent_entries (most-recent first)
}
```

If `cairn_resume` returns `TASK_NOT_FOUND`, surface the error to the
operator and ask whether they want to start a fresh task instead.

## Step 2.5 — handle a graduated task (scope: "done")

If `scope === "done"`, the task graduated between the Stop-hook resume
prompt and this `/cairn:cairn-resume` invocation (auto-graduator race).
There is nothing in flight to resume. Render a "task already shipped"
frame instead of the in-flight resume context, then **stop** — do not
run Step 3, Step 4, or read `spec.tightened.md`. Format-locked:

```markdown
**`<task_id>` already shipped — <title>**

Completed at `<completed_at>`. Final journal entry:

> <last entry summary>

The task is in `.cairn/tasks/done/<task_id>/`. Nothing left to resume.
What's next?
```

End the turn after the frame; the operator decides the next ask.

## Step 3 — render the resume context (scope: "active" only)

Emit a tight resume block that re-primes context. Format-locked:

```markdown
**Resuming `<task_id>` — <title>**

**Goal.** <goal>

**What's been done so far** (last <count> of <total_entries> entries):
- <entry 1 summary>
- <entry 2 summary>
- …

**Next step.** <next_step or "No next-step recorded; review the spec to decide.">

**Constraints in scope.** <decisions count> DECs, <invariants count> §INVs.

Continuing now.
```

After the block, **immediately read the spec** at
`.cairn/tasks/active/<task_id>/spec.tightened.md` so the rest of the
session has the full constraint set in working memory.

## Step 3.5 — pre-Read recently-touched files

Read every path in `cairn_resume.files_touched` (most-recent first,
cap at 8) **in parallel** so the per-session Read tracker has them
cached. Without this step, the first `Edit` after `/clear` will trip
`File has not been read yet` for every file the prior session edited,
forcing a wall of recovery Reads (bug-mine report #10).

Skip the pre-Read only when the file no longer exists (e.g. the prior
session deleted it before `/clear`). Best-effort — silent failures
are fine; the goal is to prime the cache, not to validate state.

## Step 4 — fetch in-scope DECs / INVs (parallel)

Call `cairn_decision_get` and `cairn_invariant_get` in parallel for
every id in `in_scope_decisions` / `in_scope_invariants`. This primes
the session with the constraint bodies — a fresh session has no
prior reads to draw on.

After loading, summarize the constraints in one short paragraph
under the resume block (≤2 sentences per constraint), then proceed
with the task's next step.

## Hard rules

- Do not edit code before Step 4 completes — context primer first,
  mutation second.
- Do not call `cairn_task_create` inside this skill — the task
  already exists; we are resuming, not starting.
- After Step 4, treat the spec.tightened.md as the authoritative
  contract; do not re-tighten.
- `next_step` from the last journal entry is the recommended starting
  point. If the operator's prompt overrides it (rare during a pure
  resume), prefer the operator.
