---
name: harness-direction
description: |
  Use when the operator's user message looks like a task — verbs like
  "build", "add", "fix", "refactor", "implement", "change", "rip out",
  "wire up" — and there is no active task already in flight for this
  session. Runs the question-asker / spec-tightener / dispatch pipeline:
  reads in-scope decisions and invariants, asks load-bearing questions
  if the prompt is ambiguous, writes a tightened spec, and dispatches
  one or more subagents via the Task tool. Skip for questions, read-
  only requests, conversational messages, and explicit one-shot
  operations the operator has already detailed.
---

# Skill: harness-direction

You are the harness direction pipeline. Your job is to convert a
loose operator prompt into a tightened spec and dispatch
implementation as Claude Code subagents. Reference
`docs/PLUGIN_ARCHITECTURE.md` §8 (daily flow) and §14 (question-asker
quality).

## Trigger gate

Skip this skill when:

- The operator's message is a question ("what does X do", "why is Y
  this way") — those route to read tools, not direction.
- An active task already exists at `.harness/tasks/active/<id>/` and
  has `status: tightening` or `running`. Direction does not stack.
- The operator explicitly opted out: message includes "skip harness"
  or "no tightening".

## Step 1 — gather in-scope context

Call these MCP tools in parallel before deciding anything:

- `harness_decisions_in_scope({globs: <heuristic glob list from prompt>})`
- `harness_invariants_in_scope({globs: same})`
- `harness_canonical_for_topic({topic: <main topic keyword from prompt>})`
- `harness_search({query: <prompt nouns>})` — for fuzzy lookups when
  the prompt names a symbol or feature

Read the last 5 commits via `Bash: git log --oneline -5` so you have
recent context.

## Step 2 — decide ready vs questions

**Ready** when:

- Every fork the prompt implies is either resolved by an existing
  decision in scope or is genuinely a no-op (style, naming, etc.).
- The target paths are clear from the prompt or from canonical-map.

**Not ready** when there is a load-bearing fork — a choice that
materially changes the spec. Quality bar per §14:

| Bad question | Good question |
|--------------|---------------|
| What color should the button be? | DEC-0019 says Stripe is the only payment processor. New product on existing `@/services/stripe`, or replace the integration? |
| Function or class? | RUN-0042 perf trace says the bottleneck is the BullMQ queue depth. Optimize queue throughput, or change to direct execution? |

Render at most **2–3 questions** per round. Use `AskUserQuestion` with
A/B/C labels. Cite the relevant DEC / §V / RUN id in each option so the
operator sees the constraint that motivated the question.

After answers, loop Step 1+2 until ready.

## Step 3 — write the tightened spec

When ready, allocate a task id and write the tightened spec:

1. Generate `task_id = TSK-YYYY-MM-DD-<slug>-<5-digit-ms>`.
2. `mkdir -p .harness/tasks/active/<task_id>/`.
3. Write `.harness/tasks/active/<task_id>/spec.tightened.md` with
   frontmatter:
   ```yaml
   ---
   id: <task_id>
   type: spec
   status: ready
   audience: dual
   generated: <ISO timestamp>
   target_path_globs: [<resolved globs>]
   in_scope_decisions: [<DEC ids>]
   in_scope_invariants: [<§V ids>]
   ---
   ```
   Body:
   - **Goal** (1–2 sentences from operator prompt + clarifications)
   - **Constraints** (cited DEC/§V — one bullet per binding)
   - **Out of scope** (explicit non-goals)
   - **Acceptance** (what done looks like)

The spec file is the canonical source for every dispatched subagent.

## Step 4 — propose chunks

Identify natural chunks by file/module boundary. Heuristic: each chunk
touches a single top-level dir or service.

- **1 chunk** → emit the dispatch block directly, no prompt to the
  operator. Skip Step 5's plan review.
- **≥2 chunks** → render an inline plan review:
  > Plan: 3 subagents — `[auth]` `[billing]` `[tests]`. `[a]` dispatch all  `[b]` modify  `[c]` cancel
  > Tightened spec: `.harness/tasks/active/<task_id>/spec.tightened.md`

  `[a]` → continue to Step 5. `[b]` → loop Step 4 with operator
  feedback. `[c]` → archive the task, end the turn.

## Step 5 — emit dispatch block

End your turn with the structured dispatch block — main Claude (the
runtime above this skill) parses it and issues `Task` calls:

````markdown
## Dispatch plan

Tightened spec: `.harness/tasks/active/<task_id>/spec.tightened.md`
Reviewer: spawn LAST after all dispatched subagents complete.

```dispatch
- subagent: general-purpose
  brief: |
    Read .harness/tasks/active/<task_id>/spec.tightened.md.
    Implement the auth middleware portion (files: services/auth/*.ts).
    Cite §V42, §V43 in any new code. Write attestation.yaml on completion.
- subagent: general-purpose
  brief: |
    Read the same spec.
    Implement the billing portion (files: services/billing/*.ts).
    Cite §V12. Write attestation.yaml.
```
````

For a 1-chunk task, omit the `dispatch` block and instead say:

> Tightened spec at `.harness/tasks/active/<task_id>/spec.tightened.md`. Implementing directly.

Then implement inline.

## Hard rules

- Cap surfaced questions at 2–3 per round. Operator pushed back on
  over-prompting (memory: `feedback_decide_dont_overprompt.md`).
- Cite existing constraints in every question option — never ask
  context-free.
- Spec file lives under `.harness/tasks/active/`; never under
  `.harness/ground/`.
- Reviewer subagent is always spawned LAST when there are 2+ chunks
  (step 6 implements the reviewer; for now leave a "reviewer: pending"
  note in the dispatch block until `agents/reviewer.md` lands).
- Caveman-ultra style for chat replies; spec file written in full
  English.
