---
name: cairn-attention
description: Resolve Cairn's pending-attention queue inline (DEC drafts, baseline findings, drift events).
when_to_use: |
  Use when SessionStart flagged `attention_count > 0` — pending DEC
  drafts in `_inbox/`, baseline sensor findings, or drift from last
  GC sweep. Also chained from `cairn-adopt` Step 5 to drain fresh
  DEC drafts. Skip when operator in-flight on task or recent turn
  already deferred this surface.
---

# Skill: cairn-attention

You are surfacing Cairn's pending-attention queue inline so the
operator can resolve drafts and findings without leaving the chat.
Spec: `docs/PLUGIN_ARCHITECTURE.md` §11.

## Step 0 — bootstrap preflight

Before surfacing any DEC choices, verify the clone is bootstrapped.
SessionStart auto-runs `cairn join` when `core.hooksPath` is unset,
so by the time this skill engages bootstrap should be wired. If
`cairn_resolve_attention` still refuses with `BOOTSTRAP_REQUIRED`,
SessionStart's auto-bootstrap failed — surface its banner (already
in additionalContext) and end the turn.

## Step 1 — read attention sources

Run these in parallel. Use the MCP tools exclusively for DEC
content; **never** `cat`, `Read`, or otherwise inline-read draft
files.

1. List draft paths only (no contents): `Bash: ls .cairn/ground/decisions/_inbox/*.draft.md 2>/dev/null`
2. For each draft id (parsed from the filename), call
   `cairn_decision_get({id: "DEC-NNNN"})` — the tool resolves both
   accepted decisions and `_inbox/` drafts. The response carries
   `id`, `title`, `status`, plus the body markdown.
3. Latest baseline audit (path only):
   `Bash: ls -1t .cairn/baseline/sensor-audit-*.yaml | head -1`
4. Drift events: `cairn_search({query: "drift"})` against the
   staleness log if any.
5. Recent invalidation events: read the per-session events marker,
   then list `.cairn/events/*.json` newer than `last_polled_ts`.

For each item, build a tuple `{kind, id, title, source, severity}`
from the MCP responses.

## Step 2 — sort and cap

Sort by:

1. Hard inconsistencies first (kind=conflict)
2. DEC drafts (kind=decision_draft) — oldest-first by ID so the
   summary surfaced earlier in the session matches the order the
   operator sees here
3. Baseline findings (kind=sensor_finding) — by sensor severity
4. Drift events (kind=drift)
5. Cross-session invalidation events (kind=invalidation)

Surface up to **4 items in a single `AskUserQuestion` call** — Claude
Code's question tool accepts a `questions` array of length ≤ 4 and
renders all of them in one inline panel. Batching keeps the operator
out of repeated round-trips. If the queue has more than 4 pending,
emit the first 4 in batch 1, then a separate single-question prompt:

- `continue` — show the next batch (up to 4 more)
- `later` — defer until next session

## Step 3 — surface up to 4 items per AskUserQuestion call

Build the `questions` array — one entry per item, all in the same
tool call. For each entry, pass the option's `detail` field as the
question `description` so the operator sees the secondary context
(source path, severity) inline with each choice. **Do not also
render any question as inline markdown** — the `AskUserQuestion` UI
is the canonical render path.

Per-kind option labels (≤ 30 chars each so mobile mode doesn't
truncate):

**DEC draft:** `accept` / `reject` / `edit first`
**Baseline finding:** `triage now` / `suppress` / `defer`
**Invalidation event:** `refresh in scope` / `continue under old` / `abort`

The tool returns answers as a parallel array (one answer per
question, in the order they were sent). Loop through the answers
and call `cairn_resolve_attention` once per item:

```
cairn_resolve_attention({kind: "decision_draft", item_id: "DEC-0042", choice: "a"})
```

Resolve calls can run in parallel (separate tool_use blocks in the
same assistant turn) — the MCP write lock serializes them on disk.

The tool dispatches by kind: `decision_draft` for accept/reject/edit,
`baseline_finding` for triage/suppress/defer, `invalidation_event`
for refresh/continue/abort, `bypass` and `review` for Stop-hook
surfaces. On `decision_draft + a`, the tool also strips the
originating source comment and replaces it with a bare `§DEC-NNNN`
symbol (matching the `§INV-NNNN` invariant convention; Cairn Lens
resolves title + body from the ledger) when the DEC came from
`init-source-comments`.

## Step 3a — `edit first` inline edit flow

When the operator picks `edit first` on a DEC draft, the resolve
call returns `{ resolved_kind: "decision_edit_pending", body }` with
the full draft markdown. **Do not point the operator at the file**
and **do not assume they can read the Read-tool output** — emit the
body as a regular chat message so it lands in the conversation.

### Step 3a.1 — render the draft as chat output (REQUIRED)

Before any tool call in this turn, write a chat message containing:

````markdown
**Editing DEC-NNNN.**

```markdown
<paste the full body returned by cairn_resolve_attention here —
title line, frontmatter, every section, no truncation>
```
````

This is a **plain assistant message** — text content, NOT an
AskUserQuestion `description` field, NOT a Read tool result. The
operator must see the actual draft text in chat before they pick.
Skipping this step is a bug — never ask "what to change?" without
first showing what's there.

### Step 3a.2 — menu

After the rendered body, on the SAME turn, call `AskUserQuestion`
with:

- `[a]` Rewrite the title
- `[b]` Rewrite the rationale (body)
- `[c]` Rewrite both
- `[d]` Cancel — keep the draft as-is and re-prompt accept/reject

### Step 3a.3 — capture replacement text

On `[a]` / `[b]` / `[c]`: ask the operator for the replacement
text inline using a single follow-up `AskUserQuestion` per field
with a freeform-style prompt — e.g.
`question: "Replacement title for DEC-NNNN?"`. Operator types the
new value in chat; capture it verbatim.

### Step 3a.4 — apply the edit

Use the `Edit` tool against the draft file at
`.cairn/ground/decisions/_inbox/DEC-NNNN.draft.md`:

- title rewrite → replace the `# DEC-NNNN — <old title>` line AND
  the `title:` frontmatter field
- rationale rewrite → replace the body content under
  `## Proposed rationale` (or whatever the section is named in
  this draft) up to the next `## ` heading or end-of-file

### Step 3a.5 — re-render and re-prompt

After the file is updated, re-render the NEW body as a chat message
(same `markdown` block format as Step 3a.1) and re-prompt with a
fresh `AskUserQuestion`: `[a] accept` / `[b] reject` /
`[c] edit again`. Loop Step 3a.3–3a.5 until the operator picks
accept or reject. Then call `cairn_resolve_attention` with that
choice on the SAME `DEC-NNNN` to finalize.

Never tell the operator "open the file in your editor." The whole
point of inline attention resolution is keeping them in the chat.

## Step 4 — close the turn

Do not write a separate "events poll cursor" stamp. The Stop hook
runs at the end of every assistant turn and advances the cursor as
part of its normal cross-session event drain (see
`cairn-core/src/hooks/runners/stop.ts`). Manual advancement is
redundant.

## Hard rules

- Surface ≤ 4 items per turn. Do not flood the chat.
- Every option must cite the underlying source (file path, sensor id,
  session id) so the operator has full context.
- Never auto-resolve. Even soft conflicts route through
  AskUserQuestion.
- Hard inconsistencies (kind=conflict) block the next cairn-direction
  invocation until resolved — make that visible in the surface text.
- Never render an inline `[a]/[b]/[c]` blockquote for a question that
  also goes through `AskUserQuestion`. Pick one render path.
- Caveman-ultra style for chat replies; full English in any DEC body
  the skill writes.
