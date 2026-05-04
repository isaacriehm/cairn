---
type: spec
status: proposal
audience: dual
generated: 2026-05-04
---

# SessionStart hook payload

This spec defines what `harness hook session-start` injects into a fresh Claude Code session running inside a harness-adopted project. Two-zone enforcement is **soft** (SessionStart instruction text + canonical-only walkers); there is no PreToolUse hook (per RESUME §2 + locked-decision feedback). This document is the gate before any hook code is written. Operator approval required before implementation.

## What Claude Code sends to the hook

Per the Claude Code SessionStart hook contract, the harness binary receives a single JSON object on stdin:

```json
{
  "session_id": "<uuid>",
  "transcript_path": "/Users/user/.claude/projects/<slug>/<session>.jsonl",
  "cwd": "/Users/user/Documents/DevPlus LLC/06 - Projects/<adopted-project>",
  "hook_event_name": "SessionStart",
  "source": "startup" | "resume" | "clear" | "compact"
}
```

Field semantics:

| Field | Use |
|-------|-----|
| `cwd` | Resolves the harness adoption — the hook walks up from `cwd` to find `.harness/` and treats that ancestor dir as `repoRoot`. If no `.harness/` is found, the hook returns no-op (see Failure modes). |
| `source` | `startup` = fresh `claude` invocation, `resume` = `claude --resume`, `clear` = post-/clear injection, `compact` = post-/compact rebuild. The harness payload is the same for `startup` + `clear` + `compact`; for `resume` it can be lighter (resume already has prior context) — recommendation in Test plan. |
| `session_id` | Logged for telemetry; not used for content injection. |
| `transcript_path` | Not used by the hook — recorded for telemetry only. |

## What `harness hook session-start` returns

Per Claude Code SessionStart contract, the harness writes one of two output shapes to stdout:

**Shape A — text injection** (simplest; recommended):

```
<plain-text content; everything written to stdout becomes additional context>
```

**Shape B — structured JSON** (gives `continue: false` escape and explicit `additionalContext` field):

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<rendered text to inject>"
  }
}
```

The harness uses **Shape B**. Reasons:
1. `continue: false` lets the hook hard-fail (e.g. `.harness/` corrupt) without leaving the session running with stale context.
2. `additionalContext` is structurally distinct from `stdout` — easier to audit + log.
3. Future-proof: if Claude Code adds metadata fields to the hook output schema, Shape B accepts them; Shape A doesn't.

Exit code semantics: `0` always for a successful injection (even when `additionalContext` is empty because no `.harness/` was found). Non-zero only on a true crash; Claude Code interprets non-zero as the hook failing and surfaces an error to the operator.

## What's IN the payload

The hook's `additionalContext` is rendered Markdown. One section per category. Field references use `cwd`-relative paths so they're stable across operators' machines.

```
# Harness state context

This Claude Code session is running inside a harness-adopted project at <cwd>.
The harness state layer has prepared the following grounding context for you. Treat
each section as authoritative for the duration of this session.
```

### Section 0 — Run handoff (highest priority, only when resuming an active run)

Injected before everything else when `source` is `resume` or `compact`, or when `startup` detects an active run with commits since `sha_pin`. See `CONTEXT_CONTINUITY_SPEC.md` for the full handoff protocol.

```
## ⟳ Resuming run TSK-<id> — <task-title>

Commits since run start:
  a3f9c12  wip(TSK-<id>): auth schema migration
  b7e2d45  wip(TSK-<id>): route handlers

Phases complete: phase-1 (auth schema), phase-2 (route handlers)
Phases remaining: phase-3 (frontend integration), phase-4 (tests)

Files touched so far:
  src/db/schema/auth.ts    [+47 -12]
  src/routes/auth/login.ts [+89 -0]
  ... (10 more, call harness_get_full({id, kind:"run"}) for full list)

Agent notes from previous phases:
  phase-2: /auth/refresh does not return a new CSRF token — frontend
  must re-fetch separately. Not in original spec.
  phase-2: approach-A (session cookies) abandoned — CSP header conflict.
  Using JWT in httpOnly cookie per DEC-0019.
```

Source: `handoff-builder.ts` reads `git log <sha_pin>..HEAD`, `git diff HEAD -- <touched-files>`, `spec.tightened.md` checkpoints, and `tasks/active/<id>/notes.md`. No LLM call — all mechanical.

Token budget for Section 0: up to 600 tokens. If git log exceeds 20 commits, truncate oldest. Section 0 is never dropped from the payload regardless of total budget.

When there is no active run with prior commits: Section 0 is omitted entirely.

### Section 1 — Two-zone reminder (always present)

```
## Two-zone reminder

Default reads/grep/glob hit the **canonical zone** only:
- AGENTS.md, CLAUDE.md, .claude/{rules,agents,skills}, docs/**, .harness/config/**,
  .harness/ground/** (excluding _inbox/), .harness/tasks/active/**

Historical content lives under .archive/, .harness/runs/terminal/,
.harness/tasks/{done,archived}/, .harness/ground/decisions/_inbox/. The harness
walkers and search tooling already exclude these paths — you do not need to
filter manually. If you genuinely need to consult historical context, call
`mcp__harness__harness_query_history(scope, question)` (returns LLM-summarized
claims with supersedes-pointers; raw archive content never enters your
context). NOTE: as of <commit>, query_history returns NOT_IMPLEMENTED — until
Phase 5 ships, treat archive as unreachable and use harness_decision_get /
harness_canonical_for_topic for current-canonical-only access.
```

This section is the **soft enforcement**. Combined with canonical-only walkers (`ground/walk.ts` + `gc/stub-hits.ts` already SKIP `.archive`), it does the work the rejected PreToolUse hook would have done.

### Section 2 — `decisions_in_scope[]`

For each decision whose `scope_globs` overlap `cwd` (i.e. all decisions when `cwd === repoRoot`):

```
## Decisions in scope (N accepted)

- **DEC-NNNN** — <title>
  status: <accepted|superseded>; scope: <globs joined>; supersedes: <id-or-none>
- ...
```

Source: `harness-core/ground/ledgers.ts` `buildDecisionsLedger({ repoRoot })` reading `.harness/ground/decisions/*.md`. Filter to `status === "accepted"` AND `!superseded_by`. Cap at 15 entries (paginated by `decided_at` desc); >15 → trailing line `…N additional decisions; call harness_decisions_in_scope(globs[]) to see them`.

Why include: agents need to know what's been decided before reading code, OR they re-litigate settled questions per PRIMER §2.

### Section 3 — `invariants_active[]`

For each `status: active` invariant whose `source_decision` scope overlaps `cwd`:

```
## §V invariants active (N)

- **V0042** — <title>
  source_decision: DEC-NNNN; sensor: <path-or-none>; e2e: <path-or-none>
- ...
```

Source: `harness-core/ground/ledgers.ts` `buildInvariantsLedger({ repoRoot })`. Cap at 10 entries; trailing line as above pointing to `harness_invariants_in_scope`.

Why include: invariants are §V backprop entries with sensors that WILL fail the run; agent should know them up front.

### Section 4 — `current_task` (optional)

Most-recent active task spec. Resolved by listing `.harness/tasks/active/*/spec.tightened.md` (fall back to `spec.md`), sorted by mtime desc, taking the first. If the directory is empty, omit the section.

```
## Current task

ID: TSK-YYYY-MM-DD-<slug>
Status: <phase>
Path: .harness/tasks/active/<id>/spec.tightened.md

<first 800 chars of spec body, no frontmatter>

(call harness_get_full({id, kind: "task"}) for full spec)
```

Cap body at 800 chars; >800 → trailing line + tool reference.

When more than one active task exists, list all in a compact table — task ID + phase + one-line title — and instruct: "Multiple active tasks; call `harness_get_full({id, kind:'task'})` to read any."

Why include: SessionStart usually fires when the operator opens a session to advance whichever task is in flight. Saves a round-trip.

### Section 5 — `quality_grades_tail` (optional)

Top 3 weakest modules from `.harness/ground/quality-grades.yaml`:

```
## Quality grades — weakest modules

- <module-key>: score N/100, pass_rate X.XX, drift_count N
- ...

Source: nightly GC pass; updated 2026-05-NN.
```

Source: parse `quality-grades.yaml` directly; don't go through MCP. If file missing, omit. If `modules: []`, omit. Cap at 3 entries.

Why include: an agent reading the prompt can see "module X is weak" and weight extra rigor when work touches it. Cheap context.

### Section 6 — `pending_drafts[]` (optional)

Drafts in `.harness/ground/decisions/_inbox/` awaiting confirm:

```
## Decision drafts pending operator confirm (N)

- **DEC-NNNN** (draft) — <subject>; capture_source: <slash:/direction|free_text|...>; received: <ISO>
- ...

These have been captured but not committed. The operator has not yet confirmed
🟢. Until they do, do not assume their content is binding.
```

Source: filesystem walk of `.harness/ground/decisions/_inbox/*.draft.md`. Parse subject from frontmatter `title`. Cap at 5 entries.

Why include: agents may otherwise observe a draft via `harness_search` and treat it as canon; this disclaims it.

### Section 7 — Tool quick-reference (always present)

Compact list of the harness MCP tools the agent is most likely to need this session:

```
## Harness MCP tools (quick reference)

Read:
  harness_decision_get(id)                  — full ADR + assertions
  harness_decisions_in_scope(path_globs[])  — decisions overlapping a path
  harness_invariant_get(id)                 — §V invariant body + sensor
  harness_canonical_for_topic(topic)        — authoritative path + verified-at
  harness_get_full(id, kind)                — fetch any artifact by id
  harness_search(query, scope[]?)           — substring index over ground+docs

Write:
  harness_record_decision(...)              — drop draft to _inbox/ for operator confirm
  harness_archive(path, reason)             — move canonical → .archive/
```

Reasoning: hooks fire before any tool-use, so agents otherwise discover the surface only by trial. Listing the high-frequency tools costs ~150 tokens and saves the agent a `tools/list` round-trip's worth of confusion.

## What's NOT in the payload (and why)

- **Full decision ADR bodies** — only ledger summaries. Agent fetches bodies on demand via `harness_decision_get`. Including bodies would blow the token budget and inject content the agent may not need.
- **Sensor pass/fail history** — beyond `quality_grades_tail`. The agent needs current state, not a per-run history.
- **`runs/active/` artifacts** — those are per-run, not per-session. SessionStart fires before a run-id exists. Agents access via `harness_get_full({kind:"run"})` once a run is started.
- **`stub-patterns.yaml` content** — Layer A patterns are ~30 regexes. Agents don't need them at session-start; they fire after the agent's diff. Including them is noise.
- **`workflow.md` body** — orchestrator-level prompt template; renders for an in-flight run. SessionStart precedes any run.
- **AGENTS.md content** — Claude Code already auto-loads `CLAUDE.md` (which `@AGENTS.md`'s) at session start. Re-including would double-count.
- **Topic registry full listing** — could grow large. Mention `harness_canonical_for_topic` in tools section; agent calls when needed.
- **Archive summaries** — by construction. Two-zone separation forbids archive content from entering context except via `harness_query_history` summarization.
- **Setup-runner state** — whether whisper/ollama/discord are configured. Adapter-layer concern, not state-layer.
- **Recent git commits / blame** — agents have native `git log` if they want it. Not state-layer.

## Token budget

Conservative per-section caps:

| Section | Cap | Typical |
|---------|-----|---------|
| 1 — Two-zone reminder | static, ~250 tokens | 250 |
| 2 — decisions_in_scope (15 × ~80) | ~1200 | 400 (5-8 decisions on a real adoption mid-flight) |
| 3 — invariants_active (10 × ~70) | ~700 | 200 (3-5 §V entries early on) |
| 4 — current_task | ~250 | 200 |
| 5 — quality_grades_tail (3 × ~30) | ~100 | 100 |
| 6 — pending_drafts (5 × ~50) | ~250 | 0 (rare) |
| 7 — tool quick-reference | static, ~250 | 250 |
| **Total typical** | — | **~1400 tokens** |
| **Total cap** | ~3000 tokens | — |

Truncation strategy when total would exceed cap:

1. Start with sections 1 + 7 (always present, fixed-cost).
2. Add section 4 (current_task) — usually one task.
3. Add section 2 (decisions) up to 15.
4. Add section 3 (invariants) up to 10.
5. Add section 6 (pending_drafts) up to 5.
6. Add section 5 (quality_grades) — 3 entries.
7. If still over cap, drop section 5, then section 6, then truncate decisions/invariants further (oldest first).

Each truncation appends a `…N more; query via harness_decisions_in_scope` line so the agent can fetch the rest on demand.

## Failure modes

| Failure | Behavior | Operator-visible? |
|---------|----------|-------------------|
| `cwd` is not under a harness-adopted dir (no `.harness/` ancestor) | Hook exits 0 with empty `additionalContext` (Shape B `{ continue: true, hookSpecificOutput: { additionalContext: "" } }`). Claude Code injects nothing. | No. Hook is a no-op for non-adopted projects. |
| `.harness/` exists but `ground/` is empty (fresh adoption) | Sections 2/3/5/6 are omitted; only sections 1, 4 (if a task exists), 7 render. | No. |
| `.harness/ground/decisions/*.md` has malformed frontmatter | Skip the malformed file with a warning logged to `.harness/staleness/log.jsonl`. The ledger writer already handles this gracefully. | No (logged). |
| `.harness/ground/quality-grades.yaml` is unparseable | Section 5 omitted. | No. |
| MCP server isn't configured in `.mcp.json` / `.claude/settings.json` | Section 7 still renders (it's just text); the agent will see the tool list but tool calls will fail with `tool not found`. Mitigation: detect missing `.mcp.json` at hook start, append a one-line warning to section 1: "(MCP server not registered — `harness install` to register; tool calls will fail until then.)" | Soft warning only. |
| `cwd` resolution to repoRoot takes too long (>1s) | Hook has soft 5s budget; if filesystem walk to find `.harness/` exceeds, cache the resolved root in `~/.local/harness/state/<cwd-hash>/repo-root` and reuse. | No. |
| Hook crashes (uncaught throw) | Exit non-zero. Claude Code surfaces the error to the operator. The session continues without context. | Yes. Operator sees a one-line error from Claude Code. |
| Hook output is not valid JSON (Shape B) | Claude Code falls back to treating stdout as Shape A plain text. | Soft fallback. |
| Frontmatter `verified-at` >60 days for a decision | Decision still listed; status section in PRIMER §3.3 says "block reads" but that's a separate hook layer the harness has not built. SessionStart does NOT block on freshness. | No. |

## Test plan

E2E (requires Claude Code + a fixture adoption):

- [ ] In this repo, run `harness init .` (with stub adapter, --skip-mirror, --skip-mapper, --skip-guided-setup) to seed `.harness/`. Verify `templates/` files land at the expected paths.
- [ ] Hand-author 2 decisions + 1 invariant + 1 active task in `.harness/ground/` and `.harness/tasks/active/` matching the spec's expected shapes.
- [ ] Add the SessionStart hook block to `.claude/settings.json` (or per-host `.claude/settings.local.json`) referencing `harness hook session-start`.
- [ ] `claude code` in this repo. Inspect the transcript JSONL for the hook firing and the `additionalContext` block.
- [ ] Verify the agent acknowledges decisions/invariants in its first response (e.g. ask "what decisions are in scope?" and check it cites the seeded DEC ids without calling `harness_decisions_in_scope`).
- [ ] Re-run with a malformed frontmatter file to verify graceful skip + log entry.
- [ ] Re-run in a directory with no `.harness/` to verify no-op behavior.

Unit smoke (no Claude Code dependency):

- [ ] `pnpm -F @devplusllc/harness-core test:smoke -- --filter=session-start` runs a fixture that:
  - constructs a temp `.harness/` with seeded decisions + invariants + a quality-grades + a draft + an active task,
  - invokes `buildSessionStartContext({ repoRoot })`,
  - asserts the returned `additionalContext` string contains:
    - the two-zone reminder verbatim,
    - each seeded DEC-id,
    - each seeded V-id,
    - the active task id,
    - the quality_grades top-3 modules,
    - the draft DEC-id,
  - asserts truncation kicks in correctly when 20+ decisions are present.

Telemetry:

- [ ] Hook execution writes one row per fire to `~/.local/harness/state/<slug>/session-start.jsonl` with `{ts, session_id, source, repo_root, sections_rendered: [1,2,3,4,5,6,7], duration_ms, total_chars}`. Useful for tuning the truncation strategy after first adoption.

## Open issues

- **`harness_query_history` is NOT_IMPLEMENTED.** The two-zone reminder text references it as the escape valve for archive reads. Until Phase 5+ ships the Tier-1 summarizer, the reminder text must include the "until then, treat archive as unreachable" caveat. Once query_history is implemented, that caveat is removed.
- **Resume-source payload variant.** When `source === "resume"`, the prior session's context is partially restored. Recommendation: emit only sections 1, 4 (current task), 7 — skip the bulk decisions/invariants list. Validate empirically against actual resume behavior before locking.
- **Per-cwd vs per-repo scoping.** When the operator opens Claude Code in a subdirectory (e.g. `core/src/integrations/`), should `decisions_in_scope` filter to decisions whose `scope_globs` overlap that subdir? Recommendation: yes — narrows the noise, and the operator can always `cd` to repo root for full context. Implementation: pass `cwd`-relative path globs into `decisionsInScope(decisions, [cwd-relative-glob])`.
