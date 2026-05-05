---
name: cairn-attention
description: |
  Use when the SessionStart context indicated `attention_count > 0` —
  pending DEC drafts in `_inbox/`, baseline sensor findings, or drift
  detected during the last GC sweep. Surfaces each item inline as
  A/B/C and resolves it through `cairn_resolve_attention`. Skip when
  the operator is in flight on a task; resume at the next idle moment.
---

# Skill: cairn-attention

You are surfacing Cairn's pending-attention queue inline so the
operator can resolve drafts and findings without leaving the chat. Spec:
`docs/PLUGIN_ARCHITECTURE.md` §11.

## Trigger gate

Only fire when:

- The most recent SessionStart additionalContext flagged
  `attention_count > 0`, OR
- The operator typed `/cairn-attention` (escape hatch — slash command
  not yet wired; for now treat any "show me pending" / "what's in the
  inbox" message as a manual trigger).

Skip when:

- A `cairn-direction` task is in flight for this session.
- The operator's prior turn was `[c]` "later" on this skill — wait
  until the next session.

## Step 1 — read attention sources

Run these in parallel. Use the MCP tools exclusively for DEC content;
**never** `cat`, `Read`, or otherwise inline-read draft files — that
wastes thousands of tokens on body text the operator never sees.

1. List draft paths only (no contents): `Bash: ls .cairn/ground/decisions/_inbox/*.draft.md 2>/dev/null`
2. For each path, call `cairn_decision_get({path: "<path>"})` — returns
   parsed `{id, title, source_file, status, capture_source}`. Use that
   to build the surface tuple. Do not Read/cat the draft body.
3. Latest baseline audit (path only):
   `Bash: ls -1t .cairn/baseline/sensor-audit-*.yaml | head -1`
4. Drift events: `cairn_search({query: "drift"})` against the staleness
   log if any.
5. Recent invalidation events: read the per-session events marker, then
   list `.cairn/events/*.json` newer than `last_polled_ts`.

For each item, build a tuple `{kind, id, title, source, severity}` from
the MCP responses.

## Step 2 — sort and cap

Sort by:

1. Hard inconsistencies first (kind=conflict)
2. DEC drafts next (kind=decision_draft) — newest first
3. Baseline findings (kind=sensor_finding) — by sensor severity
4. Drift events (kind=drift)
5. Cross-session invalidation events (kind=invalidation)

Surface at most **3 items per turn**. After three picks, prompt:

> 3 resolved. Continue with the next batch? `[a]` yes  `[b]` later

## Step 3 — surface each item as A/B/C

For each item, render an inline question. Examples:

**DEC draft:**
> DEC-0042 (draft) — "Switch payment processor from Stripe to Adyen"
> source: docs/billing.md ingestion · proposed: 2026-05-04
> `[a]` accept (move to canonical)  `[b]` reject (delete draft)  `[c]` edit before accepting

**Baseline finding:**
> Sensor `stub_catalog_hits` flagged 4 violations in `services/auth/` —
> stub strings ("TODO", "FIXME") in production paths.
> `[a]` triage now (open file)  `[b]` accept as baseline (suppress)  `[c]` defer

**Invalidation event:**
> A modified DEC-0019 (which you're using). Source: another session at
> 2026-05-04T20:14.
> `[a]` refresh in-scope  `[b]` continue under old  `[c]` abort current task

Use `AskUserQuestion` with the labels. After the operator picks, call
the resolver:

```
cairn_resolve_attention({kind: "decision_draft", item_id: "DEC-0042", choice: "a"})
```

The tool dispatches by kind: `decision_draft` for accept/reject/edit,
`baseline_finding` for triage/suppress/defer, `invalidation_event` for
refresh/continue/abort, `bypass` and `review` for Stop-hook surfaces.
On `decision_draft + a`, the tool also strips the originating source
comment and replaces it with a `// See DEC-NNNN` citation when the DEC
came from `init-source-comments`.

## Step 4 — stamp the events poll cursor

After draining cross-session invalidation events, advance the per-
session marker so the next Stop hook poll only sees newer events:

```
Bash: node -e "const x = require('@isaacriehm/cairn-core'); x.stampEventsPoll({repoRoot: process.cwd(), sessionId: process.env.CLAUDE_SESSION_ID, ts: Date.now()})"
```

(The `stampEventsPoll` runtime helper lives in cairn-core/session;
the Stop hook also calls it on every assistant turn end. Calling it
here keeps the cursor fresh after the operator drains attention.)

## Hard rules

- Surface ≤ 3 items per turn. Do not flood the chat.
- Every option must cite the underlying source (file path, sensor id,
  session id) so the operator has full context.
- Never auto-resolve. Even soft conflicts route through A/B/C.
- Hard inconsistencies (kind=conflict) block the next cairn-direction
  invocation until resolved — make that visible in the surface text.
- Caveman-ultra style for chat replies; full English in any DEC body
  the skill writes.
