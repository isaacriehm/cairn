# Using Cairn day to day

This is the most important page in the guide. Once adoption is done,
Cairn runs on every prompt — and most of what it does is invisible.
This walks through what's actually happening so you know what to
expect, what's automatic, and what you should pay attention to.

The short version of a normal session looks like this:

```
You open Claude Code in the project
   └─ SessionStart hook injects in-scope DECs/§INVs as context

You type a prompt
   └─ cairn-direction skill auto-invokes
      ├─ Loads the in-scope DECs/§INVs/canonical entries
      ├─ Asks ≤3 clarifying questions if anything is ambiguous
      ├─ Tightens the prompt into a structured spec
      └─ Dispatches subagents OR implements inline

Subagents do the work
   └─ Each subagent has MCP access; they query DECs as needed

A reviewer subagent fires last (multi-chunk tasks only)
   └─ Drafts new DECs from non-obvious choices in the diff

Stop hook surfaces inline
   └─ "Review DEC-b1e9c04 draft? [a] accept [b] reject [c] edit"

You commit → pre-commit sensors run → CI gate verifies on PR
```

Most days you'll only consciously interact with steps 2, 5, and 6.
Everything else is the system maintaining itself.

---

## Session start

When you open Claude Code in a Cairn-adopted project, the
`SessionStart` hook fires before you type anything. It does five
things, all in milliseconds:

1. **Rebuilds the ledgers.** `decisions.ledger.yaml` and
   `invariants.ledger.yaml` are regenerated from the markdown files
   on disk. This catches any DEC you (or another developer on the
   team) edited or added since the last session, including a branch
   switch.
2. **Re-scans the scope index.** `scope-index.yaml` (file → DEC/§INV
   resolution) is rebuilt by walking source citations like `// §INV-a3f7b2c`
   in your tree. Catches files moved by `git checkout`.
3. **Builds the SessionStart context.** This is the block of text
   injected into Claude's prompt before your first message. It
   contains:
   - One-line summary per in-scope DEC for files you've touched in
     the last 5 commits.
   - Active §INV titles applicable to the same scope.
   - Any pending attention count (DEC drafts, drift events, bypass
     alerts).
   - The active task title (if you have a `.cairn/tasks/active/<id>/`
     mid-flight).
4. **Refreshes the status-line badge.** The `⬡ cairn` badge in your
   Claude Code status row updates with current attention count,
   bypass count, and active task.
5. **Auto-invokes follow-up skills.** If `attention_count > 0`, the
   `cairn-attention` skill is staged to fire after your first message.
   If `.cairn/` is missing, `cairn-adopt` triggers instead.

### What "preloaded" actually means

The model sees the in-scope decisions for files you've recently
touched **before you type anything**. So if you spent yesterday
working in `src/auth/`, today's session opens with `DEC-a3f7b2c` (auth
token expiry) and `INV-a3f7b2c` (request-id header) already in the
prompt. You don't have to remind Claude what the rules are; they're
part of the conversation from message zero.

The SessionStart context is **scope-aware, not exhaustive**. A
project with 200 DECs doesn't dump 200 summaries into your prompt —
it loads maybe 5-10 that apply to where you've been working. The
agent fetches the rest on demand via MCP when its task touches
different files.

### What you actually see

In the chat itself, the SessionStart context is mostly hidden — it's
in the system-prompt portion of the conversation, not the visible
message thread. The visible cue is the status-line badge and any
attention banner. Something like:

```
⬡ cairn  ⚑ 3 pending  TSK-2026-05-08-token-expiry
```

If pending count is > 0, your first reply from Claude after typing
anything may include the `cairn-attention` skill engaging — see the
"Running cairn attention" section below.

---

## Typing a prompt

You type:

> fix the bug where users with expired tokens still get 200 from /me

What happens next.

### `cairn-direction` auto-invokes

The plugin watches every `UserPromptSubmit` event. When your
message matches the `cairn-direction` trigger gate (task verbs, bug
reports, observations, modal-verb requests), the skill engages
automatically. You don't call it — it fires on its own. Your message
above is a bug report, which the gate explicitly catches.

Skip cases (the skill doesn't engage):

- Pure information questions: *"what does this function do?"*
- Active task already in flight (no stacking).
- You explicitly opted out: *"skip cairn, just patch this"*.
- Trivial single-line edits with full specification: *"rename `foo` to
  `bar` at `baz.ts:42`"*.

### What the skill does

In sequence:

1. **Loads in-scope context** via parallel MCP calls:
   - `cairn_in_scope({ path_globs: <heuristic from prompt> })` — returns both DECs + §INVs; filter with `types: ["decision"]` / `["invariant"]` when you need only one.
   - `cairn_canonical_for_topic({ topic: <main keyword> })`
   - Plus `git log --oneline -5` for recent context.
2. **Decides ready vs questions.** "Ready" means every fork the
   prompt implies is either resolved by an in-scope decision or is
   genuinely a no-op. If there's a load-bearing fork the operator
   didn't specify, the skill asks.
3. **Asks ≤3 clarifying questions per round** via
   `AskUserQuestion`. Each option cites the relevant DEC/§INV/RUN id
   so you see the constraint that motivated the question. Multiple
   rounds are fine — the skill loops if your answer to one question
   changes the others.
4. **Writes the tightened spec.** Calls `cairn_task_create`, which
   atomically writes:
   - `.cairn/tasks/active/<task-id>/spec.tightened.md`
   - `.cairn/tasks/active/<task-id>/status.yaml`
5. **Dispatches.** Either implements inline (1 chunk) or emits a
   structured dispatch block that main Claude turns into `Task` calls
   for subagents (≥2 chunks).

### What "tightening" means

The prompt you wrote — *"fix the bug where users with expired tokens
still get 200 from /me"* — has gaps. What's "expired"? Per
`DEC-a3f7b2c`, that's >24h after issue. Where does the check live? Per
canonical-map, probably the auth middleware. What's the right
status code on rejection? Per `INV-a3f7b2c`, every response includes
`x-request-id`, but the spec says nothing about whether 401 or 403 is
right for "expired" vs "missing" token.

A tightened spec resolves these:

```markdown
---
id: TSK-2026-05-09-fix-token-expiry
type: spec-tightened
status: ready
target_path_globs:
  - packages/api/src/middleware/auth/**
  - packages/api/src/routes/me.ts
in_scope_decisions: [DEC-a3f7b2c]
in_scope_invariants: [INV-a3f7b2c]
acceptance:
  - GET /me returns 401 when token age > 24h
  - Response includes x-request-id header
  - Existing 200 path unchanged for valid tokens
  - E2E test added: e2e/auth/expired-token-rejected.spec.ts
---

# Fix: expired tokens still return 200 from /me

## Goal
Per DEC-a3f7b2c, bearer tokens expire 24h after issue. The /me handler
currently doesn't enforce this — it just decodes the JWT and returns
the user payload. Add expiry enforcement and return 401 when expired.

## Sections agent must touch
- packages/api/src/middleware/auth/verify.ts — check `exp` claim
  against `Date.now()`; throw `TokenExpiredError`.
- packages/api/src/routes/me.ts — wire the verifier into the handler.

## Decisions / Discretion split
decisions:
  - 401 (not 403) per HTTP semantics — expired credentials are
    "Unauthorized", not "Forbidden".
discretion:
  - Error envelope shape — match existing 401 responses.
```

The spec is the canonical source for every dispatched subagent. Even
when the work is simple enough that the skill implements inline, the
spec gets written first — it's the audit trail of what the operator
asked for vs what was done.

### Where the spec lives

`.cairn/tasks/active/<task-id>/`. After completion, you can move it
to `done/` (not yet auto-managed in v0). The task id format is
`TSK-YYYY-MM-DD-<slug>-<5-digit-ms>`; the millisecond suffix prevents
collisions when you spawn multiple tasks the same day.

---

## While agents work

During implementation, subagents run with full MCP access. A typical
subagent flow:

```
1. Read the tightened spec
   └─ spec.tightened.md tells it: scope, in-scope DECs, acceptance criteria

2. Pull additional context as needed
   ├─ cairn_decision_get("DEC-a3f7b2c") → full ADR + assertions
   ├─ cairn_invariant_get("INV-a3f7b2c") → invariant body + sensor reference
   ├─ cairn_canonical_for_topic("auth middleware") → exact file path
   └─ Read/Grep/Glob into the source

3. Implement
   ├─ Write/Edit files within scope
   └─ PostToolUse(Write|Edit) hook fires per file → scope-index sync

4. Self-attest
   └─ Write attestation.yaml with claims about what changed
```

You don't see most of this. The visible signal is normal Claude tool
use in the chat — `Read`, `Edit`, `Bash`. The MCP queries appear
inline as well (they look like other tool calls). If you want to
follow along, `cairn trace --tail` in another terminal pretty-prints
unified per-session events.

### The PostToolUse(Read) enrichment

When a subagent reads a source file, the `PostToolUse(Read)` hook
scans the content for `§INV-<hash>`, `§DEC-<hash>`, and `TODO(TSK-…)`
tokens. For each one found, it builds a citation legend prepended to
the read result:

```
┌─ cairn citations ─┐
│ §INV-a3f7b2c — All API responses include x-request-id header
│ §DEC-9b0f3a7 — Per-user rate limits use Redis token-bucket
└────────────────────┘
```

This means an agent reading `packages/api/src/middleware/auth/verify.ts`
that contains a `// §INV-a3f7b2c` cite gets the invariant title and
status as part of the read result. No extra tool call required.

---

## The reviewer subagent

For multi-chunk tasks (≥2 dispatched subagents), the `cairn-direction`
skill spawns the **reviewer subagent** as the final step. The
reviewer:

1. Reads the diff (`git diff --staged` plus uncommitted).
2. Reads each subagent's `attestation.yaml`.
3. Cross-checks the attestation against the actual diff (Layer B
   sensor): does the reviewer's claim match the actual diff?
4. Looks for non-obvious choices the implementation made that aren't
   already covered by an in-scope DEC. Examples:
   - Picked `argon2id` over `bcrypt` for hashing.
   - Set the rate limit to 10/min specifically.
   - Chose `crypto.randomUUID()` over a sequence id for the request
     trace token.
5. Drafts a DEC for each non-obvious choice via
   `cairn_record_decision`. Drafts land in `_inbox/`.
6. Writes its own `attestation.yaml` to the task directory.

The reviewer's role isn't to reject the work — it's to capture the
choices the work implied. The captured drafts surface in the next
step.

For 1-chunk tasks the reviewer doesn't run; the operator-driven
attention drain handles capture if needed.

---

## The stop hook

When the assistant turn ends, the `Stop` hook fires. It runs five
checks:

1. **Pending reviews.** Tasks at `.cairn/tasks/active/<id>/` without
   `attestation.yaml` — usually because the reviewer wasn't spawned
   (single-chunk task). The hook can spawn the reviewer post-hoc.
2. **Bypass commits.** Compares HEAD's last 5 commits to
   `.cairn/.attested-commits`. Any unattested SHA surfaces inline.
3. **DEC drafts.** New files in `.cairn/ground/decisions/_inbox/`
   that haven't been triaged yet.
4. **Cross-session events.** `.cairn/events/*.json` newer than this
   session's last poll. If any touch a DEC the agent used in this
   session, surface a refresh prompt.
5. **Drift events.** Anything new in `.cairn/staleness/log.jsonl`.

Whatever's pending gets surfaced via `cairn-attention`, which runs as
the next assistant action.

### What you'll actually see

```
✻ Reviewing your changes…

Found 1 new DEC draft from the reviewer:

  DEC-b1e9c04 — Refund rate limit: 10/min/user

  Rationale: Implementation chose 10 requests/minute per user,
  which is below the global API limit (60/min) and matches the
  pattern in DEC-9b0f3a7 for transactional endpoints.

[a] accept   [b] reject   [c] edit first
```

You pick. The accept path moves the draft from `_inbox/` to the
canonical zone, atomically updates `decisions.ledger.yaml` under the
per-write `flock`, and emits an invalidation event so any other live
sessions know the ledger changed.

The reject path renames the file to `DEC-b1e9c04.rejected.md` (the id
stays reserved — never recycled) and prompts you for a one-line
reason.

The edit path renders the draft body inline, gives you a menu
(rewrite title / rewrite rationale / both / cancel), and applies
your replacement before re-prompting accept/reject. You stay in chat
the whole time — no "open the file" detour.

### Quick acceptance vs editing

In practice, draft acceptance falls into two modes:

- **Quick accept (most drafts).** The reviewer extracted something
  obvious — "we picked timezone-naive UTC for new timestamps" — and
  the wording is fine. Single click, move on.
- **Edit first (load-bearing drafts).** The reviewer extracted
  something subtle and the wording matters because future agents will
  read it. Spend 30 seconds on the title and rationale; this is the
  text the agent will quote on its 90th-day prompt about the
  subsystem.

---

## Pre-commit

When you `git commit`, the versioned hook at `.cairn/git-hooks/pre-commit`
runs. Configured via `git config core.hooksPath .cairn/git-hooks`,
which adoption (and `cairn join`) sets on the clone.

The hook runs the sensor sweep:

```
$ git commit -m "fix: enforce 24h token expiry on /me"
✓ Layer A (stub catalog)        — 0 hits
✓ decision-assertions           — DEC-a3f7b2c a1, a2 evaluated
[main 7f3a2c1] fix: enforce 24h token expiry on /me
```

For small diffs, this is sub-second. For diffs that touch many files
(big refactors), seconds. The hook never blocks a commit on a
soft warning — only hard sensor failures stop the commit.

### What a hard failure looks like

```
$ git commit -m "wip"
✗ Layer A (stub catalog)             — 1 hit
   src/services/payment/refund.ts:47
     pattern: throw new Error('not implemented')
     fix: implement, or cite a TSK: // TODO(TSK-2026-05-09-1)
✗ Commit blocked.
```

Resolve the finding (implement, or cite the deferring task) and try
again.

### What `--no-verify` does

`git commit --no-verify` skips the pre-commit hook. Useful sometimes
— a hot-fix that needs to land before the sensor catalog is updated,
for example. But it doesn't escape Cairn:

1. `.cairn/.attested-commits` doesn't get the SHA appended (because
   the hook didn't run).
2. The next stop hook diffs HEAD against `.attested-commits`, sees
   the new commit isn't attested, and surfaces it inline.
3. CI runs the same sensors against the PR. Any sensor failure
   blocks the merge.

Bypass is allowed locally but always surfaced and always re-checked
at the gate.

---

## Running `cairn attention`

The `cairn-attention` skill auto-invokes when the SessionStart hook
flags pending items. You can also invoke it explicitly: type
`/cairn-attention` or run `cairn attention` from a terminal.

When to deliberately run it:

- **Right after adoption.** The pipeline produces dozens to hundreds
  of DEC drafts. You drain them in the first session post-adoption.
- **After a heavy refactor.** Big PRs surface multiple reviewer
  drafts.
- **When the badge shows N pending.** `⬡ cairn ⚑ 12 pending` means
  the queue is non-trivial.
- **Periodically.** Even with no badge prompt, running it once a week
  catches drift events and stale findings.

### Interactive triage

For up to 4 items, you see them in a single `AskUserQuestion` panel.
For more, the skill batches: 4 items, then a "continue / later"
prompt to advance.

Recorded decisions **auto-accept** straight into the ledger, so the
queue is mostly baseline sensor findings, drift events, and the
occasional dedup-fallback DEC draft (a near-duplicate of an
already-accepted decision). The review checkpoint for auto-accepted
decisions is the committed (or local) diff, not a per-draft prompt.

---

## Practical tips

A handful of patterns that come up often.

### Querying decisions while you work

You don't have to be in Claude Code to query Cairn's state. The MCP
server is `cairn mcp serve`, but you can also use the CLI:

```bash
cairn scope --files src/auth/jwt.ts,src/auth/refresh.ts
# returns: in-scope DEC summaries + INV summaries

cairn doctor
# checks: ledger health, missing files, drift count, bypass count
```

For deeper queries, write a tiny script that uses the MCP tools
directly. Examples:

```bash
# What does DEC-a3f7b2c say?
cairn mcp call cairn_decision_get '{"id":"DEC-a3f7b2c"}'

# Where does rate limiting live?
cairn mcp call cairn_canonical_for_topic '{"topic":"rate limiting"}'

# Search for anything mentioning idempotency
cairn mcp call cairn_search '{"query":"idempotency"}'
```

### Recording a decision before the agent acts

Sometimes you know in advance that the next prompt is going to make a
load-bearing call and you want it recorded *before* the agent runs.
Drop a DEC manually:

> Use `cairn_record_decision` to capture: "Refund retries use
> exponential backoff with jitter, max 5 attempts, base 1s." Scope
> `packages/billing/refunds/**`.

The agent calls the MCP tool; the draft lands in `_inbox/`; you
accept it. Now the next implementation prompt is constrained by your
just-recorded choice.

### Checking what's in scope for a file

Before opening a tricky file, ask:

> What's in scope for `packages/api/src/routes/me.ts`?

Claude calls `cairn_in_scope` and reports back. Useful when:

- You're about to refactor and want to know what constraints apply.
- You're reviewing someone else's PR and want context.
- You inherited the module and don't have the context to start from.

### Trace logs

Every hook + MCP tool + claude subprocess writes to
`~/.cairn/trace/trace-YYYY-MM-DD.jsonl`.

```bash
cairn trace --tail               # follow live
cairn trace --errors-only        # filter to errors
cairn trace --session <id>       # filter to one session
cairn trace --json               # raw JSONL for piping
```

Useful when something feels off — tightening took longer than
expected, the sensor sweep produced surprising findings, the stop
hook didn't surface a draft you expected. The trace tells you what
ran and what it returned.

### What to do when something feels wrong

Three quick checks:

1. **`cairn doctor`** — runs the standard health checks (ledger
   integrity, hook installation, scope-index freshness, bypass
   count). Reports a single line per check.
2. **`cairn trace --errors-only --tail 50`** — last 50 errors across
   all sessions. Most issues show up here.
3. **Status-line badge color.** Red means active blocker (drift +
   bypass + pending all >0). Amber means non-zero attention but
   nothing blocking. Green means clean state.

If something looks broken, file an issue at
[github.com/isaacriehm/cairn/issues](https://github.com/isaacriehm/cairn/issues)
with the trace excerpt. Most reports get a same-day response.

---

## What you don't have to do

A short list of things you'll see in the architecture docs but don't
ever have to think about:

- **You don't manage the ledgers.** They rebuild on every
  SessionStart from the markdown files.
- **You don't update the scope-index.** It rebuilds on
  SessionStart and on every PostToolUse(Write|Edit).
- **You don't trigger the GC sweep.** The stop hook auto-runs it
  when overdue.
- **You don't compose SessionStart context manually.** The hook
  composes it from current state.
- **You don't dispatch subagents.** The `cairn-direction` skill
  handles it via Claude Code's built-in `Task` tool.
- **You don't run sensors by hand.** Pre-commit hook + CI gate cover
  it.

The pattern: **automate state maintenance, surface decisions for
review.** The system never silently makes a load-bearing call on
your behalf, but it does silently keep its own indices fresh.

---

## What to read next

- [`adoption.md`](adoption.md) — what the one-time setup looks like
  in practice.
- [`decisions.md`](decisions.md) — DEC creation, scope design, the
  supersedes chain in depth.
- [`reference.md`](reference.md) — fast lookups for CLI commands,
  MCP tools, file locations.
