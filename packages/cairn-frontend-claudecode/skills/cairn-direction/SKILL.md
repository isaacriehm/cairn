---
name: cairn-direction
description: Spec-tightener + subagent dispatcher. Engage on code-change asks — verbs, bug reports, observations. Pivot-aware on active tasks.
when_to_use: |
  Engage when operator's message implies code change. ANY triggers:

    1. Task verbs — "build", "add", "fix", "refactor", "implement",
       "change", "rip out", "wire up", "remove".
    2. Bug reports — "X broken", "production fails on …", "crashes
       when …".
    3. Problem observations — "X leaks Y", "endpoint returns wrong
       data".
    4. Modal-verb requests — "should reject", "must enforce".
    5. Symptom+cause — operator names what's wrong + where, no
       explicit "fix this" verb needed.
    6. Mission continuation — active mission + short prompt like
       "continue", "go", "next", "do it", "keep going", "ship it",
       or autonomy phrase ("autonomously", "until ctx",
       "don't pause"). Vibe coders type "continue" expecting work
       to happen — Step 2.6 handles the auto-pick.

  Bug reports + observations ARE tasks.

  Skip ONLY when:
    - Pure info question ("what does X do", "where Z defined") AND
      no active mission to continue.
    - Operator opted out: "skip cairn", "just do it" (pinpointed).
    - Trivial fully-specified edit ("rename foo to bar at f.ts:42").

  Active-task case is NOT a skip — engage Step 0.5 (pivot
  detection).
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
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_task_create,mcp__plugin_cairn_cairn__cairn_task_complete,mcp__plugin_cairn_cairn__cairn_in_scope,mcp__plugin_cairn_cairn__cairn_canonical_for_topic,mcp__plugin_cairn_cairn__cairn_search,mcp__plugin_cairn_cairn__cairn_mission_get,mcp__plugin_cairn_cairn__cairn_mission_start,mcp__plugin_cairn_cairn__cairn_mission_accept_draft,mcp__plugin_cairn_cairn__cairn_mission_set_exit_gate,AskUserQuestion)
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
- The operator explicitly opted out: message includes "skip cairn",
  "no tightening", "just do it", or "don't ask, just".
- The change is a single trivial edit the operator has already
  pin-pointed ("rename foo to bar at file.ts:42") — direct action
  beats ceremony.

**Bug reports and broken-behavior observations are IN scope** even
when no task verb appears. If the operator names a symptom in the
codebase, treat it as a request to fix.

**Active task is NOT a skip case.** If
`.cairn/tasks/active/<id>/status.yaml` exists with
`phase: running`, run **Step 0.5 — pivot detection** below before
deciding what to do. Cairn must help the operator graduate or pivot
the existing task, not silently hide.

## Step 0.4 — operator-rejection capture (auto-learn from "bad")

When the operator pushes back on prior work ("bad, I don't like X",
"stop using Y", "never do Z again", "remove that cast", "that's
wrong"), they're surfacing a project rule that isn't yet codified.
If you only apply the local fix and move on, the same pattern will
re-appear next session and the operator will catch it again.
Capture the rejection as a draft DEC so the rule materializes into
ground state — sensor + reviewer + agent SessionStart context all
read DECs, so a once-rejected pattern stays rejected.

Run this step BEFORE Step 0.5 (pivot detection) and BEFORE the
main direction flow. It's additive — it does not replace whatever
fix the operator's prompt also requests; you still apply that
fix in the same turn after capturing the rejection.

Trigger gate — ALL must hold:

1. Operator's current prompt contains a rejection signal
   (case-insensitive substring match):
   - `bad,` / `bad.` / `is bad` / `was bad` (as a verdict — not
     embedded in words like "badge")
   - `don't like` / `do not like` / `dislike` / `i hate`
   - `stop using` / `don't use` / `do not use` / `never use`
   - `avoid` (as a directive)
   - `remove that` / `kill that` / `kill the`
   - `that's wrong` / `that is wrong` / `wrong approach`
   - `no, ` as a standalone sentence starter rejecting prior work
2. The prior assistant turn produced visible code or a concrete
   pattern (file edit, diff, code snippet, MCP tool call output).
   Skip when the rejection is about a question or proposal, not
   shipped code.
3. The rejection points at an extractable pattern — a specific
   identifier, token sequence, or code shape you can encode as a
   regex. Skip vague "this whole thing is bad" rejections with no
   anchor (they need conversational follow-up, not a DEC).

When all three hit, capture before doing anything else:

### 0.4a — extract the pattern

Read the prior turn's diff or proposed code. Identify the exact
shape the operator rejected:

- Concrete regex that catches the shape (e.g.
  `\bas\s+unknown\s+as\b` for an "as unknown as" cast rejection,
  `@ts-ignore` for ts-ignore rejection,
  `console\.log` for stray console-log rejection).
- Scope globs where the rule applies (default to a sensible
  language-wide glob — `**/*.ts` / `**/*.tsx` for TypeScript,
  `**/*.py` for Python, etc.). When the rejection was in a
  specific subsystem and the operator's language scopes it
  there ("don't do this in the API layer"), narrow the globs.
- A one-line rationale (operator's reason, or your best
  inference from context).

When you cannot extract a concrete regex within ~30s of
reasoning, skip this step — the rejection is too vague.
Conversationally acknowledge and apply the local fix; do NOT
draft a DEC with a hand-wavy assertion.

### 0.4b — draft the DEC

Call `cairn_record_decision` with the inbox-targeted shape (target
defaults to `"inbox"` so the entry lands as a draft in
`.cairn/ground/decisions/_inbox/` for operator review):

```
cairn_record_decision({
  title: "Reject `<rejected pattern>`",
  summary: "<one-line rationale — operator's reason or inferred>",
  scope_globs: [<extracted globs>],
  body_markdown: <markdown body — see template below>,
  assertions: [{
    id: "a1",
    kind: "text_must_not_match",
    pattern: "<extracted regex>",
    in_globs: [<extracted globs>],
  }],
})
```

`body_markdown` template:

```
## Decision

Reject `<pattern>` in <scope>. Operator flagged the shape inline:
"<verbatim rejection quote, trimmed to ~80 chars>".

## Why

<one-line rationale — operator's reason or inferred>.

## Enforcement

Pre-commit sensor + reviewer subagent diff scan via assertion
`a1` (text_must_not_match). Any commit introducing this pattern
blocks unless a paired `// cairn-allow: <reason>` justification
sits on the same line.
```

### 0.4c — surface ONE LINE, then continue

After the tool call returns successfully:

```
Captured rejection → draft `DEC-<id>` queued for review (`/cairn-attention`).
```

Then continue the normal direction flow (Step 0.5 → Step 1 →
…). The operator's current-turn fix request still needs handling
— don't end the turn on the capture line.

### 0.4d — duplicate-guard

Before drafting, do a quick check that the same pattern isn't
already a DEC. Call `cairn_search({query: "<the regex or token>",
kind: "decision"})` and skip the draft when a DEC with the same
`assertion.pattern` already exists in `accepted` status. Surface:

```
Pattern already in DEC-<existing-id>; not re-drafting.
```

This keeps the inbox clean across multi-session rejection
volleys (operator rejects the same thing twice → one DEC, not
two duplicate drafts).

## Step 0.5 — pivot detection (run when an active task exists)

Before Step 1, check for an active task:

```bash
ls .cairn/tasks/active/ 2>/dev/null
```

If empty → skip this step, proceed to Step 1.

For each active dir, read `spec.tightened.md` (frontmatter + first
H1) and `status.yaml` (`phase` field). Pick the first task whose
`phase` is `running` (the auto-graduator transitions completed work
out of `running` so anything left here is genuinely in flight).

**Continuation auto-pickup (cold session, no resume primer yet).**
If the operator's message matches a continuation token (`continue`,
`go`, `next`, `keep going`, `more`, `proceed`) AND the journal has
entries from a different session_id than the current one (cold
resume after `/clear`), do NOT engage the pivot prompt and do NOT
restart from Step 1. Instead, run the same auto-resume primer the
SessionStart banner describes:

1. `cairn_resume({ task_id: <active task id> })` — pulls spec,
   in-scope DECs/INVs, journal tail, `files_touched` union.
2. Read every path in `cairn_resume.files_touched` (cap 8,
   most-recent first) in parallel so the per-session Read tracker
   is primed before any Edit.
3. Read `.cairn/tasks/active/<task_id>/spec.tightened.md`.
4. Pick up from `cairn_resume.next_step` and continue work.

Skip the pivot AskUserQuestion entirely for continuation messages —
the operator typed `continue` to keep going, not to be re-asked.

Compare the operator's new prompt to the active task's title +
goal:

- **Same subject** (operator is following up on the same work — same
  files / same noun set / explicit reference like "now also handle
  the X case in that fix") → no pivot. Do NOT call task_create. Treat
  the prompt as continued work on the active task; respond directly
  without spawning a new direction loop.
- **Diverging subject** (different feature area, different file
  globs, different noun set) → surface the pivot prompt via
  `AskUserQuestion`:

  > Active task `TSK-<id>` is **<title>** (<phase>). Your new ask
  > looks unrelated. Pick:
  >
  > - `[a]` complete TSK-<id> first (I'll wait until you wrap it
  >   then handle the new ask)
  > - `[b]` pivot — abort TSK-<id>, start fresh on the new ask
  > - `[c]` keep TSK-<id> active, treat the new ask as a sub-task
  >   under it (single TSK; both lines of work get the same spec)

  On `[a]` — end the turn with a one-line note: "TSK-<id> still
  active; finish it then re-ask." Operator continues the prior task.
  On `[b]` — call `cairn_task_complete({task_id: <id>, outcome:
  "aborted", summary: "pivoted to: <one-line summary of new ask>"})`,
  then proceed to Step 1 for the new prompt.
  On `[c]` — append the new ask as an additional bullet under the
  existing spec's `## Goal` section via `Edit`, end the turn. The
  operator continues with the augmented spec; reviewer will attest
  both lines of work together.

## Step 0.7 — mission scope detection (when no active mission)

Call `cairn_mission_get({})`. If `active: true`, skip this step
entirely — Step 2.5 handles anchoring to the existing cursor. If
`active: false`, scan the operator's prompt for **mission-shape
signals**. Trigger when ANY 2+ hit:

1. **Verb count.** 3+ distinct task verbs in the prompt (build, add,
   fix, refactor, implement, wire, remove, migrate, replace,
   redesign, ship).
2. **Enumerated phases.** Numbered list ("1. … 2. … 3. …"), ordinal
   adverbs ("first … then … then …"), or explicit "phase 1 …
   phase 2 …".
3. **Multi-feature span.** 3+ distinct feature nouns from different
   areas (e.g. schema + auth + UI; not 3 fields on one form).
4. **Scope phrasing.** "build the whole X", "redesign Y end-to-end",
   "rewrite the Z system", "ship the entire X module".
5. **Length + structure.** Prompt >300 words AND contains 2+ H2/H3
   sections or bulleted sub-deliverables.

Single-trigger prompts stay as single tasks — the bar is two
independent signals. A 600-word prose dump with no enumeration and
one feature noun is just a verbose single-task ask.

If the trigger fires, surface ONE question via `AskUserQuestion`:

> Your ask spans multiple deliverables. Pick the shape:
>
> - `[a]` mission — multi-phase plan with cursor-tracked phase
>   exits. Cairn drafts a phase roadmap from your prompt and you
>   approve it before any task starts.
> - `[b]` single task — treat as one scoped task; you handle the
>   sub-deliverables yourself in conversation.

On `[b]`: skip the rest of this step, proceed to Step 1 as a normal
single task.

On `[a]`:

1. Pick a slug — first 3-4 words of the prompt's first sentence,
   kebab-case, ≤30 chars (e.g. "rewrite-auth-and-billing").
2. `mkdir -p .cairn/missions/_drafts/` then `Write` the operator's
   prompt verbatim to `.cairn/missions/_drafts/<slug>.md`. Prepend
   an H1 line giving the mission a tight title (≤60 chars). Body is
   the prompt itself; preserve any enumeration the operator wrote.
3. Call `cairn_mission_start({spec_path: ".cairn/missions/_drafts/<slug>.md", exit_gate: "prompt"})`.
   The tool returns a draft envelope: `{proposed_title, spec_path,
   exit_gate, phases: [{id, title, depends_on, exit_criteria}, …],
   truncated, llm_used}`. Nothing has been written to disk by the
   server yet — the draft is in your turn buffer only.
4. Surface the draft to the operator via `AskUserQuestion` so they
   can confirm the phase shape before commit:

   > Drafted roadmap — `<proposed_title>` (`<phases.length>` phases):
   >
   > 1. `<phase[0].id>` — <phase[0].title>
   > 2. `<phase[1].id>` — <phase[1].title>
   > … (list every phase; cite `depends_on` when non-empty)
   >
   > Pick:
   >
   > - `[a]` accept — call `cairn_mission_accept_draft` and proceed
   > - `[b]` edit first — open the draft and tighten before
   >   accepting
   > - `[c]` cancel — abandon the mission, fall through to single
   >   task

5. On `[a]`: call `cairn_mission_accept_draft({title:
   <proposed_title>, spec_path: <spec_path>, exit_gate: <exit_gate>,
   phases: <phases>})` with the values from the Step 3 response.
   The mission is now live with the cursor on phase-1. Proceed to
   Step 1 — `cairn_task_create` will auto-anchor to the cursor
   phase via Step 2.5 default behaviour.
6. On `[b]`: end the turn with one line pointing the operator to the
   draft path: "Mission draft at `.cairn/missions/_drafts/<slug>.md`
   — edit phases inline, then re-invoke." They edit the prompt /
   the draft and re-ask; this skill re-runs Step 0.7 from scratch.
7. On `[c]`: skip the mission, proceed to Step 1 as a single task.
   The draft file at `.cairn/missions/_drafts/<slug>.md` stays on
   disk — operator deletes if unwanted.

This is the ONLY auto-mission path. The CLI surface
(`cairn mission start <spec_path>`) remains for operator-driven
flows where they hand-write a planning doc outside any prompt.

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

- `cairn_in_scope({path_globs: <heuristic glob list from prompt>})`
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

## Step 2.5 — mission anchoring (when an active mission exists)

Call `cairn_mission_get({})`. If `active: false`, skip this step.

If `active: true`, you have an active mission with a cursor phase.
The new task should be **anchored to the cursor phase** by default —
`cairn_task_create` auto-stamps `mission_id` + `phase_id` from the
cursor when both fields are omitted. Do NOT pass them explicitly
unless you're overriding to a different phase.

**Off-mission detection.** Read the cursor phase's `title` +
`exit_criteria` from the `cairn_mission_get` response. If the
operator's prompt clearly diverges from the phase scope (different
file globs, different feature area, no overlap with exit_criteria),
surface ONE question via `AskUserQuestion`:

> Active mission `<mission_id>` is at phase `<phase_id>` —
> `<phase_title>`. Your ask looks orthogonal. Pick:
>
> - `[a]` side-task — spawn this as a normal task with NO mission
>   anchor (`mission_id: ""`); it won't count toward phase progress.
> - `[b]` fold into current phase — anchor to `<phase_id>` anyway;
>   the task graduating will count toward phase exit.
> - `[c]` advance to a different phase first — list pending phases
>   and let the operator pick (rare; only when the prompt clearly
>   matches an upcoming phase's scope).

On `[a]`: pass `mission_id: ""` to `cairn_task_create` in Step 3.
On `[b]`: omit mission fields (default cursor pickup wins).
On `[c]`: surface the pending phase list via a follow-up
`AskUserQuestion`; the operator picks one. Then call
`cairn_mission_advance({phase_id: <current>, choice: "force"})` to
skip the current phase, then invoke this Step again so the new
cursor phase is the anchor.

**Aligned-on-mission case** (operator's prompt matches the cursor
phase): no extra prompt; default cursor pickup handles everything.
The task gets `mission_id` + `phase_id` stamps automatically.

## Step 2.6 — autonomous mission continuation (vibe-coder mode)

Operators are often "vibe coders" who don't know what a mission is,
don't know PR names like `3.5-BH1`, and don't read mission internals.
They type `continue` or `go` and expect the next chunk of work to
just happen. The autonomy-config friction (AskUserQuestion about
`exit_gate`, AskUserQuestion about which PR) defeats the point.

This step replaces both questions with **silent action**: detect the
continuation intent, flip the mission to `exit_gate: auto` if it
isn't already, auto-pick the next pending PR from the cursor phase's
exit criteria, and skip straight to spec tightening.

Trigger gate — ALL must hold:

1. `cairn_mission_get` returned `active: true`.
2. No active task in `.cairn/tasks/active/` (Step 0.5 already
   determined this; if Step 0.5 routed you here, an active task
   would have taken the "continue prior work" path instead).
3. Operator's prompt matches a continuation intent. Match any of:
   - Bare continuation (case-insensitive, ≤30 chars after trim):
     `continue`, `go`, `next`, `more`, `do it`, `run it`,
     `keep going`, `ship it`, `proceed`, `more please`,
     `the mission`, `execute`, `start`, `begin`
   - Autonomy phrase (case-insensitive substring, any length):
     `execute autonomously`, `operate autonomously`,
     `run autonomously`, `just keep going`, `don't pause`,
     `do not pause`, `don't stop`, `do not stop`, `no questions`,
     `don't ask`, `ship the whole`, `ship the entire`,
     `execute the whole mission`, `run the entire mission`,
     `until context`, `until ctx`, `autonomously`

   Do NOT trigger on bare `yes` / `ok` / `sure` — those are
   typically answers to AskUserQuestion prompts from the prior
   turn, not mission continuation requests.

When all three hit, proceed silently:

### 2.6a — flip `exit_gate` if needed (one-time, no AskUserQuestion)

If `cairn_mission_get` returned `exit_gate: "prompt"` AND
`.cairn/missions/<mission_id>/.autonomy-prompted` does NOT exist:

```
cairn_mission_set_exit_gate({exit_gate: "auto"})
```

Then write the marker file (Write tool, path
`.cairn/missions/<mission_id>/.autonomy-prompted`, body the current
ISO timestamp). Surface ONE LINE:

```
Mission set to auto-advance — phase boundaries won't pause.
```

No AskUserQuestion. The operator just told you to continue; they
don't want a config confirmation. The marker prevents this step from
firing again for the same mission (operators who change their mind
can `rm .cairn/missions/<mission_id>/.autonomy-prompted`).

When the marker already exists OR `exit_gate` was already `auto`,
skip the flip silently and move to 2.6b.

### 2.6b — auto-pick the next pending PR from exit_criteria

Read the cursor phase from `cairn_mission_get`:

- `cursor.active_phase` → phase id
- `cursor.active_phase_exit_criteria` (or look it up in
  `phases[<active_phase>].exit_criteria` from the same response)

Extract PR slugs from the exit_criteria prose. Pattern:
`\d+\.\d+-[A-Z]+\d+` (e.g. `3.5-BH1`, `3.5-OP1`, `3.5-LR1`).
Preserve order — the operator-authored exit_criteria lists PRs in
intended execution order.

For each PR slug, check whether it has already graduated. A PR is
considered graduated when any task in
`phase_progress[<active_phase>].task_ids` has a `done/<task_id>/`
directory whose `status.yaml` contains a `title` or `id`
referencing the PR's bare token (e.g. `bh1`, case-insensitive).

Pick the FIRST PR slug whose bare token is NOT in the graduated set.
This is the next task to spawn.

When the exit_criteria has no PR-shaped tokens (free-form text),
infer the next deliverable from the prose — pick the first
sentence-clause that names a concrete output ("BullMQ queue", "AI
follow-up", etc.). Use it as the task `slug` + `title`. The vibe
coder doesn't care that you inferred; they care that work starts.

### 2.6c — render one-line status, then jump to Step 3

Surface a single line:

```
Continuing mission `<mission_id>` → starting `<pr-or-deliverable>`.
```

Then skip Steps 1, 2, 2.5 (all handled implicitly here) and proceed
to **Step 3 — write the tightened spec**. Use the picked PR slug as
the task `slug`, the PR's role from exit_criteria as the `title`,
and the phase's overall goal as the `goal`. `cairn_task_create`
auto-stamps `mission_id` and `phase_id` from the cursor.

After dispatch + completion, `cairn_task_complete` returns a
`next_action_hint` block that tells the model what's next — another
PR in the same phase, the first PR of an auto-advanced next phase,
or "mission complete". The model self-chains via that hint without
returning here, so a single `continue` from the operator covers the
entire remaining mission (modulo ctx-window limits).

### 2.6d — when does this step yield to the operator?

Yield ONLY when:

- The phase's exit_criteria has no PR slugs AND the prose is too
  ambiguous to infer a concrete deliverable. Surface ONE
  `AskUserQuestion` asking the operator to name what's next.
- A spawned subagent reports a failure that needs operator review
  (the reviewer's normal attestation path handles this).
- Context approaches the configured threshold (the Stop hook's
  ctx-threshold surface handles this independently).

Otherwise, keep going. The vibe coder asked for autonomy; deliver
it.

Skip this step silently when the trigger gate fails. Normal
cairn-direction flow (Steps 1+ on a code-change prompt) still works
as before.

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
  slug: <kebab, 3-80 chars, e.g. "token-expiry" or "f01-route-claim-revalidation-via-status-svc">,
  title: <≤80 chars, statusline-friendly, e.g. "Fix token expiry">,
  goal: <1-2 sentence narrative of the operator's intent>,
  target_path_globs: [<resolved globs>],  // optional — pass when you can pin scope; omit to let Cairn infer
  in_scope_decisions: [<DEC-NNNN ids from Step 1>],
  in_scope_invariants: [<INV-NNNN ids from Step 1>],
  constraints: [<one bullet per binding, citing DEC/§INV>],
  out_of_scope: [<explicit non-goals>],
  acceptance: [<what done looks like>],
  module: <top-level dir or package slug touched>,
})
```

`title` is the short label that renders in the statusline + lens (e.g.
`⬡ cairn  TSK-… Fix token expiry`). Keep it ≤80 chars or the server
rejects with `VALIDATION_FAILED`. `slug` is 3-80 lowercase-kebab chars
(letters, digits, hyphens). `goal` is the longer 1–2 sentence
description that fills the spec body's Goal section. `target_path_globs`
is optional in v0.12.x — pass it when you can pin scope cleanly;
omit it for cross-cutting work and Cairn infers from `module`/`goal`.

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
- **Self-attest by default.** Close every task with
  `cairn_task_complete({outcome, summary})`. The `summary` IS the
  attestation — write 1-2 paragraphs of what landed. The reviewer
  subagent is opt-in (operator-invoked when they explicitly ask
  for a diff review or DEC-drafting sweep).
- **Do not mirror Stop-hook surfaces.** Cairn's Stop hook owns the
  surfaces for stalled tasks, unattested commits, context-threshold
  warnings, and phase-exit prompts. If you can already see one of
  those surfaces will fire on this turn (e.g. you graduated several
  tasks and a stall warning is imminent, or context is climbing),
  do NOT pre-render the same A/B/C question yourself — that double-asks
  the operator. Trust the hook.
- **Honor autonomy intent.** If the operator's prompt or recent
  history contains an autonomy phrase ("advance autonomously",
  "do not stop", "ignore stop hooks", "no questions") OR the active
  mission has `exit_gate: "auto"`, suppress non-blocking
  AskUserQuestion calls within this skill. Mid-flow clarifications
  the operator already opted out of — like "stall triage?" or
  "context at 65%?" — are explicitly waived. The only allowed pause
  is a genuine spec ambiguity that would change the deliverable.
- **`in_scope_decisions` + `in_scope_invariants` must be populated** from
  the Step 1 `cairn_in_scope` response when that response named any
  DECs / §INVs. Empty arrays on a task that touches an in-scope glob
  are a bug — they yield "task spec carries no scope" downstream and
  let subagents work blind. If Step 1 returned matches, pass them to
  `cairn_task_create`; never pass `[]`.
- When dispatching subagents OR implementing inline, instruct
  follow-up markers in source as `// TODO(TSK-<task_id>)` — never
  bare `TODO` (the citation scanner only resolves the cite form).
- Match the project's chat-reply voice from
  `.cairn/ground/brand/voice.md` when present (Cairn's spec-delta
  scan injects it into SessionStart context). Default to plain
  English when the file is absent or empty. The spec file the skill
  writes is always full English regardless of voice.
