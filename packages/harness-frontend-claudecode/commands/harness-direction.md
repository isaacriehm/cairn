---
description: |
  Force the harness-direction question-asker / spec-tightener pipeline on
  the supplied prompt. Escape hatch when auto-invocation misses — e.g.
  the prompt is borderline conversational, or the operator wants to
  force tightening on a question-shaped message.
argument-hint: "<task description>"
---

# /harness-direction

Manually trigger the `harness-direction` skill on the argument prompt.
Equivalent to the auto-invoked path but bypasses the trigger gate.

## Behavior

Treat the slash-command argument as the operator's task prompt. Invoke
the `harness-direction` skill with that prompt. The skill runs its
normal pipeline — gather in-scope context, ask load-bearing questions,
write tightened spec, dispatch chunks.

If the argument is empty:

> /harness-direction needs a task description. Example: `/harness-direction add a webhook for stripe disputes`

## When to use

- The operator's prior message was conversational ("can we talk about
  X") but the operator now wants harness to take it as a task.
- Auto-invoke skipped a borderline message (read-only at a glance, but
  actually a refactor request).
- Forcing tightening on a partially-specified prompt to surface its
  ambiguities before writing code.
