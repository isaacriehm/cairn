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
SessionStart's auto-bootstrap failed — call `cairn_bootstrap_retry`
once to retry inline. On `ok: true`, fall through to Step 0.3. On
`ok: false`, surface the `failed_steps` list to the operator and
end the turn (the `remediation` field of the error envelope cites
this same tool plus a Claude Code restart as the recovery paths).
Never reference `cli.mjs` or `cairn join` directly in the chat
surface — Plugin spec §11 forbids exposing CLI subcommands to the
operator.

## Step 0.2 — mission attention (phase_ready_to_exit + drift)

Before the regular attention queue, handle mission-specific surfaces.
These don't go through `cairn_resolve_attention` — missions have
their own resolver tool (`cairn_mission_advance`).

Preload the mission tools alongside the existing attention tools:

```
ToolSearch(select:mcp__plugin_cairn_cairn__cairn_mission_get,mcp__plugin_cairn_cairn__cairn_mission_advance,AskUserQuestion)
```

Then call:

```
cairn_mission_get({})
```

If `active: false`, skip this step.

### 0.2a — phase ready to exit

Stop hook injected a `phase_ready_to_exit` hint into the reason block
when the active phase's tasks all graduated. Surface a single
`AskUserQuestion`:

> Mission `<mission_id>` (`<title>`) — phase `<active_phase>`:
> `<active_phase_title>` ready to exit.
>
> Exit criteria: `<active_phase_exit_criteria>`.
>
> - `[a]` mark phase done, advance cursor (`exit`)
> - `[b]` not yet — more tasks needed (`not_yet`)
> - `[c]` defer 24h (`defer`)

Dispatch:

```
cairn_mission_advance({phase_id: "<active_phase>", choice: "exit" | "not_yet" | "defer"})
```

When the mission's `exit_gate` is `auto`, the cursor already
advanced silently (no prompt fires). When `manual`, the Stop hook
suppresses the surface entirely — operator must invoke advance
directly.

Render a one-line outcome after the call:

```
✓ Phase advanced (next: <next_phase>) · M/N done.
```

If `closed: true`, the mission auto-closed on last phase complete:

```
✓ Mission MIS-… complete. Archived.
```

### 0.2a.5 — pending mission resync

If `.cairn/missions/<id>/_resync.json` exists for the active mission,
the operator amended the source spec doc. Read the marker file
(`Read` tool — it's a small JSON), surface the diff via
`AskUserQuestion`:

> Mission `<mission_id>` resync pending — spec at `<spec_path>`
> proposes:
>
> - +<N> phase(s) added: `<id1>`, `<id2>`
> - −<M> phase(s) removed: `<id3>`
> - ↻<K> phase(s) renamed
> - <P> phase(s) with new exit_criteria
>
> Pick:
>
> - `[a]` accept — rewrite roadmap.md, refresh spec.md, reconcile
>   phase_progress (added → pending, removed → dropped)
> - `[b]` reject — delete the marker, keep roadmap.md unchanged

Dispatch via:

```
cairn_mission_resync_accept({outcome: "accept" | "reject"})
```

After the call, render a one-line outcome:

```
✓ Resync applied (+N −M ↻K). Cursor: <next_phase>.
```

If the marker file is missing, skip this sub-step.

### 0.2b — mission drift

If `mission_get` returned a non-empty `drift_phase_ids`, the operator
edited `roadmap.md` mid-mission and removed phases that still have
graduated task records in `state.json`. Surface a single block per
drift id:

> Mission drift detected — phase `<id>` no longer in roadmap.md but
> has graduated tasks linked.
>
> - `[a]` accept drift — drop phase from `phase_progress` (orphans
>   the linked task records; the tasks themselves remain in
>   `tasks/done/`).
> - `[b]` restore phase to roadmap.md (operator edits the file by
>   hand; this option defers the prompt for 24h while they work).
> - `[c]` defer 24h

Dispatch via `cairn_mission_advance({phase_id: "<drift_id>", choice: "drop"})`
on `[a]` — `drop` removes the drifted entry from `phase_progress`
and journals the resolution. The tool refuses `drop` when the phase
is still present in roadmap.md (operator restored it). For `[b]`
and `[c]`, write the defer file the same way as 0.2a (`choice:
"defer"` is reserved for cursor-phase exits; for drift defers the
skill writes `.cairn/.mission-phase-deferred-until` directly with
the drifted id).

If both 0.2a and 0.2b have items, batch them under one `AskUserQuestion`
call (max 4 questions per batch — same rule as the main queue).

After mission attention resolves, fall through to the regular
attention queue below.

## Step 0.3 — large-queue routing (browser triage GUI)

When `attention_count > 15`, the inline `AskUserQuestion` flow burns
one MCP round-trip per draft and 4-cap batches force the operator
through dozens of turns. Above the threshold, hand off to the browser:

1. Call `cairn_attention_serve({})`. Returns
   `{ url, port, sentinel_path }`. The browser auto-opens. If it
   doesn't, the operator clicks the URL.

2. Print a **single chat message** containing the URL as a clickable
   markdown link, **nothing else**:

   ```markdown
   ⚑ N pending — opened triage UI:

   → **[Open Cairn Attention](<url>)**

   Triage all drafts in the browser. Click "I'm done" when finished —
   this session resumes automatically.
   ```

3. Call `cairn_attention_wait({})` (default 1800s). The MCP tool
   blocks until the operator clicks "I'm done" in the UI (or the
   server idles out). Returns the `DoneState`:

   ```
   { ok, reason: "done"|"idle"|"abort",
     accepted, rejected, merged, edited,
     startedAt, endedAt }
   ```

4. Render a one-line summary to the operator:

   ```markdown
   ✓ Triage complete (reason). Accepted N · Rejected M · Merged K · Edited E.
   ```

5. **Exit the skill.** Do **not** run Steps 0.5 / 0.7 / 1 / 2 / 3 —
   the GUI handled all of them.

If `attention_count <= 15`, fall through to the inline flow below.

## Step 0.5 — bulk-accept obvious DEC drafts

Phase 7b emits one DEC draft per "rationale"-class JSDoc / block
comment. On a busy monorepo this produces hundreds of drafts that
no operator will sort through one click at a time. Before any
interactive triage, drain the obvious ones via the bulk tool:

```
cairn_bulk_accept_attention({})
```

Tool default `threshold: "high"` only auto-promotes drafts the
heuristic is confident about — file in `high_stakes_globs` /
`route_handler_globs` / `dto_globs`, prose 80–800
chars, decision-verb tokens (`chose`, `because`, `enforce`, …),
JSDoc tags. Stamps `capture_confidence` on every draft + invariant
so subsequent passes can sort. Returns counts:

```
{ decsScanned, decsAccepted, decsByConfidence: {high, medium, low},
  acceptedIds, invariantsScanned, invariantsByConfidence }
```

Render a one-line summary to the operator before continuing:

```
Auto-accepted N obvious DEC drafts. M remain for triage
(K medium / L low). Invariants: P high / Q medium / R low —
all stamped, none auto-promoted.
```

Do **not** call this tool with `threshold: "medium"` or `"low"`
without explicit operator consent — those settings widen
acceptance significantly (medium ≈ 60% accept, low ≈ 100%).
Operator can opt in via the CLI: `cairn attention bulk-accept
--threshold medium --dry-run` to preview, then re-run without
`--dry-run`.

After this step, the inbox holds only medium + low-confidence
drafts. Continue with the normal triage flow below.

## Step 0.7 — flag duplicate DEC drafts

Phase 7b emits one DEC draft per essay-class comment, so the same
idea appearing in N files produces N near-duplicate drafts. Cluster
them deterministically (no LLM, no quota) before the operator sees
the per-item triage:

```
cairn_attention_dedup({})
```

Returns:

```
{ draftsScanned, clusters, draftsInClusters, reducible,
  thresholdFloor, thresholdDefinite }
```

Each entry in `clusters` is a `{ tier, averageSimilarity, drafts[] }`.
Tiers:

- `definite` (Jaccard >= 0.5) — render under `## Definite duplicates`.
  Default action: keep the first-listed draft (lowest DEC id) as the
  survivor; surface a single `AskUserQuestion` per cluster:
  - `[a]` keep DEC-NNNN, reject the rest (default)
  - `[b]` keep them all (treat as distinct)
  - `[c]` reject the whole cluster
- `potential` (0.4 to 0.5) — render under `## Potential duplicates`.
  Operator triages each member normally in Step 3; surface the
  cluster as context only, do not auto-merge.

Render the summary as one block right before the per-item prompts:

```
Found N duplicate clusters across M drafts (P reducible).
  • Definite (≥0.5): X clusters, Y drafts
  • Potential (0.4–0.5): Z clusters, W drafts
```

For each definite cluster the operator picked `keep ... reject the rest`,
loop over the non-survivor ids and call:

```
cairn_resolve_attention({ kind: "decision_draft", choice: "b",
  item_id: "DEC-NNNN" })
```

`choice: "b"` renames the draft to `.rejected.md` so the id stays
reserved (never recycled). The survivor stays in `_inbox/` and flows
into Step 3 normally.

If `clusters.length === 0`, skip rendering — the dedup section is
empty noise when there's nothing to cluster.

## Step 1 — read attention sources

Run these in parallel. Use the MCP tools exclusively for DEC
content; **never** `cat`, `Read`, or otherwise inline-read draft
files.

1. List draft paths only (no contents): `Bash: ls .cairn/ground/decisions/_inbox/*.draft.md 2>/dev/null`
2. For each draft id (parsed from the filename), call
   `cairn_decision_get({id: "DEC-NNNN"})` — the tool resolves both
   accepted decisions and `_inbox/` drafts. The response carries
   `id`, `title`, `status`, plus the body markdown.
3. **Conflicts** — list pending contradictions written by phase 7c:
   `Bash: ls .cairn/ground/conflicts/*.md 2>/dev/null`. Each
   filename has the shape `<a-id>__<b-id>.md` where both ids match
   `(DEC|INV)-<hash7>`. Read each conflict file directly via the
   `Read` tool — these files are NOT in the ledger and have no MCP
   getter. Parse the YAML frontmatter to capture `a_id`, `b_id`,
   `a_source`, `b_sot_path`, `reasoning`. Treat the rendered prose
   blocks (`## DEC-<a> ...`, `## DEC-<b> ...`) as the verbatim
   sides to surface.
4. Latest baseline audit (path only):
   `Bash: ls -1t .cairn/baseline/sensor-audit-*.yaml | head -1`
5. Drift events: `cairn_search({query: "drift"})` against the
   staleness log if any.
6. Recent invalidation events: read the per-session events marker,
   then list `.cairn/events/*.json` newer than `last_polled_ts`.

**Rejected DECs are not in the queue.** Reject is a final operator
decision; surfacing rejected ids every session would force re-triage
of already-resolved items. When the operator explicitly asks to
reconsider a specific id ("restore DEC-1234567", "un-reject DEC-NNNN"),
call `cairn_resolve_attention` with that id directly — the tool
auto-restores from `.rejected.md` (or already-accepted `<id>.md`)
transparently and applies the chosen `a/b/c`. Response carries
`auto_restored_from: "rejected" | "accepted"` so the skill can
surface the rollback in its summary.

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
**Conflict:** `keep A side` / `keep B side` / `merge both` / `archive both`
  — see Step 3b for the side-by-side prose render that MUST appear
    on the same turn before the question lands.

The tool returns answers as a parallel array (one answer per
question, in the order they were sent). Loop through the answers
and call `cairn_resolve_attention` once per item:

```
cairn_resolve_attention({kind: "decision_draft", item_id: "DEC-deadbee", choice: "a"})
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

## Step 3b — `kind: conflict` side-by-side render (REQUIRED)

Plan §5.4.1 — when a conflict item is in the batch, the operator
must see both verbatim sides AND the Haiku judge's reasoning before
they pick. AskUserQuestion's option labels alone don't carry that
prose. Render a chat message on the SAME turn as the
`AskUserQuestion`, BEFORE the tool call lands:

````markdown
**Conflict** — `<a-id>` (`<a_source>`) vs `<b-id>` (`<b_sot_path>`)

**`<a-id>` says:**

```
<verbatim prose A from the conflict file>
```

**`<b-id>` says:**

```
<verbatim prose B from the conflict file>
```

**Difference:** <one-line excerpt from `reasoning` frontmatter>
````

Then the AskUserQuestion `[a]` / `[b]` / `[c]` / `[d]` lands as
described in Step 3. The tool dispatches to:

```
cairn_resolve_attention({
  kind: "conflict",
  item_id: "<a-id>__<b-id>",     // filename minus .md
  choice: "a" | "b" | "c" | "d",
  rationale: "<optional operator note>"
})
```

Resolution outcomes (plan §5.4.1 — **never rewrite source files**):

- `[a]` keep A → B gets `status: superseded`, `superseded_by: <a-id>`;
  A gets `supersedes: <b-id>`. Conflict file deleted.
- `[b]` keep B → mirror of [a].
- `[c]` merge → fresh DEC carries both sides + operator's `rationale`
  as a third "Merge rationale" section. Both old DECs/INVs get
  `status: superseded`, `superseded_by: <merged-id>`. Conflict file
  deleted. (Mixed DEC/INV merges produce a DEC; pure INV/INV merges
  stay INV.)
- `[d]` archive both → both sides flip `status: archived`. Conflict
  file moves to `.cairn/ground/conflicts/_archived/`. Reopen later
  by restoring it manually.

After the resolve call, render a one-line outcome to chat:

```
✓ Conflict resolved — <verb> (<winner-id> stands · <loser-id> superseded).
```

**Hard rule** — losing-side prose stays in the source file. CLAUDE.md /
AGENTS.md / `.claude/rules/*` are operator-curated narrative; cairn
never silently rewrites them. The next phase 5b pass will re-cite
or surface the orphan; the operator can manually clean up the doc.

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
- Match the project's chat-reply voice from
  `.cairn/ground/brand/voice.md` when present (Cairn's spec-delta
  scan injects it into SessionStart context). Default to plain
  English when the file is absent or empty. Any DEC body the skill
  writes is always full English regardless of voice.
