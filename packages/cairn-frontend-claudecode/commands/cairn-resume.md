---
description: Resume an active Cairn task after `/clear`. Reads the task journal + spec and primes context cold.
argument-hint: <task_id>
---

# /cairn-resume

You are resuming a Cairn task in a fresh-context session. The
operator just `/clear`ed mid-task and pasted this command to rebuild
state. The argument is the `task_id` (format: `TSK-<slug>-<7-hex>`)
or omitted (defaults to the most-recently-touched active task).

## Step 1 — preload tools

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_resume,mcp__plugin_cairn_cairn__cairn_in_scope,mcp__plugin_cairn_cairn__cairn_decision_get,mcp__plugin_cairn_cairn__cairn_invariant_get)
```

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
  title: "<spec H1>",
  goal: "<spec ## Goal section>",
  in_scope_decisions: ["DEC-…"],
  in_scope_invariants: ["INV-…"],
  target_path_globs: ["…"],
  recent_entries: [
    { ts, session_id, summary, next_step?, files_touched?, decisions_loaded? }
  ],
  next_step: "<last entry's next_step or null>",
  total_entries: <number>
}
```

If `cairn_resume` returns `TASK_NOT_FOUND`, surface the error to the
operator and ask whether they want to start a fresh task instead.

## Step 3 — render the resume context

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
