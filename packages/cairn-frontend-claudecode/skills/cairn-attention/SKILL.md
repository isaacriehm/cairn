---
name: cairn-attention
description: Resolve Cairn's pending-attention queue inline.
when_to_use: |
  Use when the SessionStart context flagged `attention_count > 0` —
  pending DEC drafts in `_inbox/`, baseline sensor findings, or drift
  detected during the last GC sweep. Skip when the operator is in
  flight on a task or when the most recent turn already deferred this
  surface.
disable-model-invocation: true
---

# Skill: cairn-attention

You are surfacing Cairn's pending-attention queue inline so the
operator can resolve drafts and findings without leaving the chat.
Spec: `docs/PLUGIN_ARCHITECTURE.md` §11.

## Step 0 — bootstrap preflight

Before surfacing any DEC choices, verify the clone is bootstrapped.
`cairn_resolve_attention` will refuse with `BOOTSTRAP_REQUIRED` on a
non-bootstrapped clone — do not waste an operator interaction on a
question that's destined to fail.

```bash
git config --get core.hooksPath
```

If the value is not `.cairn/git-hooks`, invoke `cairn-bootstrap`
first (or run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" join`
silently if this skill was reached as a chained call from
`cairn-adopt` and the operator already consented to adoption). After
bootstrap succeeds, continue.

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

Surface at most **3 items per turn**. After three picks, prompt via
`AskUserQuestion` (not inline markdown):

- `continue` — show the next batch
- `later` — defer until next session

## Step 3 — surface each item via AskUserQuestion

For each item, render the question through `AskUserQuestion`. Pass
the option's `detail` field as the AskUserQuestion `description` so
the operator sees the secondary context (source path, severity)
inline with each choice. **Do not also render the question as inline
markdown** — the AskUserQuestion UI is the canonical render path.

Per-kind option labels (≤ 30 chars each so mobile mode doesn't
truncate):

**DEC draft:** `accept` / `reject` / `edit first`
**Baseline finding:** `triage now` / `suppress` / `defer`
**Invalidation event:** `refresh in scope` / `continue under old` / `abort`

After the operator picks, call:

```
cairn_resolve_attention({kind: "decision_draft", item_id: "DEC-0042", choice: "a"})
```

The tool dispatches by kind: `decision_draft` for accept/reject/edit,
`baseline_finding` for triage/suppress/defer, `invalidation_event`
for refresh/continue/abort, `bypass` and `review` for Stop-hook
surfaces. On `decision_draft + a`, the tool also strips the
originating source comment and replaces it with a bare `§DEC-NNNN`
symbol (matching the `§V<N>` invariant convention; Cairn Lens
resolves title + body from the ledger) when the DEC came from
`init-source-comments`.

## Step 4 — stamp the events poll cursor

After draining cross-session invalidation events, advance the
per-session marker so the next Stop hook poll only sees newer
events:

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
- Never auto-resolve. Even soft conflicts route through
  AskUserQuestion.
- Hard inconsistencies (kind=conflict) block the next cairn-direction
  invocation until resolved — make that visible in the surface text.
- Never render an inline `[a]/[b]/[c]` blockquote for a question that
  also goes through `AskUserQuestion`. Pick one render path.
- Caveman-ultra style for chat replies; full English in any DEC body
  the skill writes.
