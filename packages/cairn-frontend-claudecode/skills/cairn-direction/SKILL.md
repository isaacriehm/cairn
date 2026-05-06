---
name: cairn-direction
description: Spec-tightener + subagent dispatcher. Engage on code-change asks — verbs, bug reports, observations.
when_to_use: |
  Engage when operator's message implies code change. ANY triggers:

    1. Task verbs — "build", "add", "fix", "refactor", "implement",
       "change", "rip out", "wire up", "remove".
    2. Bug reports — "X broken", "users get Y when should get Z",
       "production fails on …", "crashes when …".
    3. Problem observations — "X leaks Y", "endpoint returns wrong
       data", "tokens older than 24h still authenticate".
    4. Modal-verb requests — "should reject", "must enforce".
    5. Symptom+cause — operator names what's wrong + where, no
       explicit "fix this" verb needed.

  Bug reports + observations ARE tasks. Conservative trigger
  defeats the spec-tightener pipeline.

  Skip ONLY when:
    - Pure info question ("what does X do", "where Z defined") no
      implied change.
    - Active task at `.cairn/tasks/active/<id>/` with
      `phase: tightening`/`running` — direction does not stack.
    - Operator opted out: "skip cairn", "just do it".
    - Trivial one-line edit fully specified ("rename foo to bar in
      baz.ts:42").
---

# Skill: cairn-direction

You are the Cairn direction pipeline. Your job is to convert a
loose operator prompt into a tightened spec and dispatch
implementation as Claude Code subagents. Reference
`docs/PLUGIN_ARCHITECTURE.md` §8 (daily flow) and §14 (question-asker
quality).

## Step 0 — preload tools (REQUIRED FIRST CALL)

Before anything else, run **one** `ToolSearch` call that batch-loads
every deferred tool the rest of the skill needs. The cairn MCP tools
+ `AskUserQuestion` are deferred — without preloading, you will fall
back to inline prose questions and the contract breaks.

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_task_create,mcp__plugin_cairn_cairn__cairn_decisions_in_scope,mcp__plugin_cairn_cairn__cairn_invariants_in_scope,mcp__plugin_cairn_cairn__cairn_canonical_for_topic,mcp__plugin_cairn_cairn__cairn_search,AskUserQuestion)
```

After this call, all phase tools + the question tool are loaded for
the rest of the skill. **Do NOT skip this step** — it is the only way
to get `AskUserQuestion`'s schema into the tool registry.

## Trigger gate

The `when_to_use` field above is the canonical trigger contract.
This section reinforces the SKIP cases that surface most often:

- Pure information questions ("what does X do", "why is Y this
  way", "where is Z defined") with no implied change → route to
  read tools, not direction.
- An active task already exists at `.cairn/tasks/active/<id>/` and
  has `phase: tightening` or `phase: running` — direction does not
  stack.
- The operator explicitly opted out: message includes "skip cairn",
  "no tightening", "just do it", or "don't ask, just".
- The change is a single trivial edit the operator has already
  pin-pointed ("rename foo to bar at file.ts:42") — direct action
  beats ceremony.

**Bug reports and broken-behavior observations are IN scope** even
when no task verb appears. If the operator names a symptom in the
codebase, treat it as a request to fix.

## Hard contract — ONE CHECKPOINT, BLOCKING

The contract is binary: **`.cairn/tasks/active/<task_id>/status.yaml`
exists on disk → you are tightened, proceed. Does not exist → you
are NOT tightened. No `Edit`, no `Write`, no `NotebookEdit`, no
mutating `Bash`. Period.**

This applies even when:

- You have read enough source to feel "ready"
- The bug looks one-line obvious
- Step 2 produced zero clarifying questions
- The operator's prompt seems fully specified

A "no questions needed" outcome from Step 2 means: write the spec
NOW with the questions field empty. It does NOT mean "skip the
spec". Step 3 is the FIRST DELIVERABLE, not a downstream artifact.

Forbidden before `status.yaml` exists:

- `Edit` / `Write` / `NotebookEdit` against any file in `src/`,
  `apps/`, `packages/`, `lib/`, or any other code dir
- `Bash` commands that mutate state — `git commit`, `git checkout`,
  `npm install`, `pnpm install`, anything that touches files

Permitted before `status.yaml` exists:

- `Read`, `Glob`, `Grep` — reconnaissance is required for tightening
- `Bash` for read-only commands — `git log`, `git diff`, `git
  status`, `ls`, `cat`, etc.
- All `cairn_*` MCP tools

If the in-scope tools return empty arrays, that does NOT mean "no
context, fix freely" — it means the operator's prompt may touch
files outside the cairn's current ground state. Still write the
spec. The spec captures the operator's intent and the implementation
plan; the in-scope tools just inform it.

**Self-check before any `Edit`/`Write` tool call**: does
`.cairn/tasks/active/<id>/status.yaml` exist for the task you're
about to mutate code for? If no → you have not finished Step 3.
Return to Step 3.

## Step 1 — gather in-scope context

Call these MCP tools in parallel before deciding anything:

- `cairn_decisions_in_scope({globs: <heuristic glob list from prompt>})`
- `cairn_invariants_in_scope({globs: same})`
- `cairn_canonical_for_topic({topic: <main topic keyword from prompt>})`
- `cairn_search({query: <prompt nouns>})` — for fuzzy lookups when
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
| What color should the button be? | DEC-1919191 says Stripe is the only payment processor. New product on existing `@/services/stripe`, or replace the integration? |
| Function or class? | RUN-0042 perf trace says the bottleneck is the BullMQ queue depth. Optimize queue throughput, or change to direct execution? |

**Per-round batching**: render at most **3 questions in a single
`AskUserQuestion` call**. Total questions across rounds is unbounded —
ask as many as the spec needs. Use multiple rounds (re-invoke
`AskUserQuestion` on the next turn) when the answer to one question
materially changes the others; resolve the dependency first, then
re-derive the downstream questions in the next round.

**Always use the `AskUserQuestion` tool — never inline.** A trailing
"Proceed with that plan?" or "Should I do X or Y?" rendered in chat
text bypasses the operator's structured-answer surface. If you have
a question, it goes through `AskUserQuestion` with concrete A/B/C
options. No exceptions. Inline questions are interpreted by the
operator as preamble and routinely drop the load-bearing
clarification.

Use A/B/C labels. Cite the relevant DEC / §INV / RUN id in each option
so the operator sees the constraint that motivated the question.

After each round of answers, loop back to Step 1+2 to re-evaluate. A
tightened spec routinely takes 2–3 rounds for non-trivial work; one
round is fine when the prompt is already mostly specified.

## Step 3 — write the tightened spec (ALWAYS, server-enforced)

This step ALWAYS executes after Step 1+2. There is no "ready, no
questions → skip to Step 4" path. A bug-report prompt with an
obvious one-line fix STILL produces a `spec.tightened.md` +
`status.yaml` pair before any source mutation.

**Call the `cairn_task_create` MCP tool — it is the only sanctioned
path.** The server allocates the `task_id` (with the correct
`TSK-YYYY-MM-DD-<slug>-<5-digit-ms>` format you cannot misformat),
atomically writes `spec.tightened.md` and `status.yaml` under
`.cairn/tasks/active/<task_id>/`, and returns the id + paths. Manual
`Write` to those files is no longer the contract — call the tool.

```
cairn_task_create({
  slug: <kebab-2-to-4-words, e.g. "token-expiry">,
  title: <≤50 chars, statusline-friendly, e.g. "Fix token expiry">,
  goal: <1-2 sentence narrative of the operator's intent>,
  target_path_globs: [<resolved globs>],
  in_scope_decisions: [<DEC-NNNN ids from Step 1>],
  in_scope_invariants: [<INV-NNNN ids from Step 1>],
  constraints: [<one bullet per binding, citing DEC/§INV>],
  out_of_scope: [<explicit non-goals>],
  acceptance: [<what done looks like>],
  module: <pilot module slug or top-level dir touched>,
})
```

`title` is the short label that renders in the statusline + lens (e.g.
`⬡ cairn  TSK-… Fix token expiry`). Keep it ≤50 chars or the server
rejects with `VALIDATION_FAILED`. `goal` is the longer 1–2 sentence
description that fills the spec body's Goal section.

The tool returns `{ task_id, spec_path, status_path, in_scope_decisions,
in_scope_invariants }`. Capture `task_id` for Steps 4-5; cite
`spec_path` in any dispatch block; trust that both files are on disk
when the call returns success.

If the tool returns an error envelope (`TASK_DIR_EXISTS` is the only
expected one — millisecond collision), retry once. Any other error
means cairn is unhealthy; surface it to the operator and stop.

The spec file is the canonical source for every dispatched subagent;
the status file is the canonical handoff signal for sessions resuming
mid-task. Both are server-controlled — you cannot ship malformed
frontmatter or skip `status.yaml`.

## Step 4 — propose chunks

**Re-entry guard**: before doing anything in this step, verify both
`.cairn/tasks/active/<task_id>/spec.tightened.md` AND
`.cairn/tasks/active/<task_id>/status.yaml` exist on disk. If either
is missing, return to Step 3. Do NOT continue with chunking,
dispatch, or implementation.

Identify natural chunks by file/module boundary. Heuristic: each chunk
touches a single top-level dir or service.

- **1 chunk** → emit the dispatch block directly, no prompt to the
  operator. Skip Step 5's plan review.
- **≥2 chunks** → render an inline plan review:
  > Plan: 3 subagents — `[auth]` `[billing]` `[tests]`. `[a]` dispatch all  `[b]` modify  `[c]` cancel
  > Tightened spec: `.cairn/tasks/active/<task_id>/spec.tightened.md`

  `[a]` → continue to Step 5. `[b]` → loop Step 4 with operator
  feedback. `[c]` → archive the task, end the turn.

## Step 5 — emit dispatch block

End your turn with the structured dispatch block — main Claude (the
runtime above this skill) parses it and issues `Task` calls:

````markdown
## Dispatch plan

Tightened spec: `.cairn/tasks/active/<task_id>/spec.tightened.md`
Reviewer: spawn LAST after all dispatched subagents complete.

```dispatch
- subagent: general-purpose
  brief: |
    Read .cairn/tasks/active/<task_id>/spec.tightened.md.
    Implement the auth middleware portion (files: services/auth/*.ts).
    Cite §INV-4242424, §INV-4343434 in any new code. If you leave any
    explicit follow-up in source (deferred edge case, missing piece
    that belongs to this task but is out of scope for this chunk),
    drop a `// TODO(TSK-<task_id>)` cite on that line so future
    Reads surface the task context. Write attestation.yaml on completion.
- subagent: general-purpose
  brief: |
    Read the same spec.
    Implement the billing portion (files: services/billing/*.ts).
    Cite §INV-1212121. Write attestation.yaml.
```
````

For a 1-chunk task, omit the `dispatch` block and instead say:

> Tightened spec at `.cairn/tasks/active/<task_id>/spec.tightened.md`. Implementing directly.

Then implement inline. Same TODO(TSK-) rule applies — if you leave any
explicit follow-up in source for this task, drop
`// TODO(TSK-<task_id>)` on the line so the citation legend resolves
it on future Reads.

## Hard rules

- Cap each `AskUserQuestion` call at 3 questions, but the total across
  rounds is unbounded. Loop rounds when answers depend on each other.
- Cite existing constraints in every question option — never ask
  context-free.
- Spec file lives under `.cairn/tasks/active/`; never under
  `.cairn/ground/`.
- Reviewer subagent is always spawned LAST when there are 2+ chunks.
- When dispatching subagents OR implementing inline, instruct
  follow-up markers in source as `// TODO(TSK-<task_id>)` — never
  bare `TODO` (the citation scanner only resolves the cite form).
- Caveman-ultra style for chat replies; spec file written in full
  English.
