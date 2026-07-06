---
description: Force cairn-direction tightening on the supplied prompt. Escape hatch when auto-invocation misses.
argument-hint: "<task description>"
---

# /cairn:cairn-direction

Manually trigger the `cairn-direction` skill on the argument prompt.
Equivalent to the auto-invoked path but bypasses the trigger gate.

## Behavior

Treat the slash-command argument as the operator's task prompt. Invoke
the `cairn-direction` skill with that prompt. The skill runs its
normal pipeline — gather in-scope context, ask load-bearing questions,
write tightened spec, dispatch chunks.

If the argument is empty:

> /cairn:cairn-direction needs a task description. Example: `/cairn:cairn-direction add a webhook for stripe disputes`

## When to use

- The operator's prior message was conversational ("can we talk about
  X") but the operator now wants Cairn to take it as a task.
- Auto-invoke skipped a borderline message (read-only at a glance, but
  actually a refactor request).
- Forcing tightening on a partially-specified prompt to surface its
  ambiguities before writing code.
