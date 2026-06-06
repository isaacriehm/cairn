---
type: filesystem-layout
status: draft-v2
audience: dual
generated: 2026-05-02
supersedes: docs/orchestration/STATE_SCHEMA.md (deleted; was Postgres-based)
depends-on:
  - docs/orchestration/PRIMER.md (§4 grounding layer, §11 anti-patterns)
  - docs/orchestration/MCP_SURFACE.md (read/write tool surface)
---

# Filesystem Layout — Disk-only state for Cairn

> **This is a technical implementation spec.** If you're trying to *use*
> Cairn rather than modify it, start with the user guide:
> [Quick reference](guide/reference.md) has the practical file-location
> table; [Core concepts](guide/concepts.md) explains what each artifact means.

Replaces the prior Postgres design. Everything lives on disk. Two-zone canonical/historical separation. Hook-enforced. Portable to any project via `npx @isaacriehm/cairn init`.

## 0. Decision summary (locked)

| Concern | Decision |
|---------|----------|
| Primary state | Filesystem only — markdown + YAML + JSONL |
| Database | None |
| Frontend adapter | Claude Code plugin is the primary operator surface; CLI is bootstrap + debug; VS Code / Cursor extension is a parallel read-only consumer |
| Concurrency model | Per-write `flock` on `.cairn/.write-lock`; per-session state partition under `.cairn/sessions/<id>/` |
| Branching | None — direct commits to main, gated by sensors at pre-commit + CI |
| Two zones | `canonical` (default agent visible) / `historical` (`.cairn/runs/terminal/`, `.cairn/tasks/done/` — excluded from walkers) |
| Provenance | YAML frontmatter required on every load-bearing markdown |
| Append-only writes | Via Cairn MCP tools — no read-before-write penalty |

---

## 1. Top-level layout in any Cairn-adopted repo

The layout below is **stack-agnostic**. Subdirectories under `.cairn/ground/{schema,routes,events}/` are populated only when the operator's project has a generator that produces them — the init mapper proposes generators per detected stack signature (Drizzle / Prisma / SQLAlchemy → schema dump; OpenAPI / NestJS / FastAPI → routes table; project-defined event registry → events). Projects without those concerns simply have empty/missing directories; the layout itself doesn't change. Likewise `tasks/active/<id>/spec.md` is populated by the active frontend adapter (Claude Code plugin in v0.1.0); the layout stores no adapter-specific structure.

```
<repo-root>/
├── AGENTS.md                       ← TOC pattern, ~150 lines max         CANONICAL
├── CLAUDE.md                       ← @AGENTS.md alias                     CANONICAL
├── .claude/
│   ├── settings.json               ← MCP registration + hooks             CANONICAL
│   ├── settings.local.json         ← per-host overrides                   GITIGNORED
│   ├── agents/                     ← project-specific agent role files (optional, operator-owned)
│   ├── skills/                                                            CANONICAL
│   └── rules/*.md                                                         CANONICAL
├── docs/                           ← authored docs (operator-owned)       CANONICAL
│   └── ...                         ← whatever structure the project already uses
├── .cairn/                         ← Cairn's own state                  MIXED
│   ├── config/
│   │   ├── workflow.md             ← per-task prompt template + YAML cfg  CANONICAL
│   │   ├── sensors.yaml            ← sensor registry                      CANONICAL
│   │   ├── stub-patterns.yaml      ← Layer A catalog (grows via /oops)    CANONICAL
│   │   └── trust-policy.yaml       ← per-command trust posture            CANONICAL
│   ├── ground/                     ← THE single source of truth           CANONICAL (committed)
│   │   ├── manifest.yaml           ← {path, sha256, verified_at, classification, audience} per file
│   │   ├── decisions/
│   │   │   ├── _inbox/             ← draft decisions awaiting confirm     GITIGNORED
│   │   │   ├── DEC-0001.md         ← committed accepted decisions
│   │   │   └── decisions.ledger.yaml ← compact, always-loaded summary
│   │   ├── invariants/
│   │   │   ├── INV-0001.md         ← §INV invariant (monotonic, never reused)
│   │   │   └── invariants.ledger.yaml
│   │   ├── .archive/               ← retired DEC/INV graveyard            NON-CANONICAL (committed)
│   │   │   ├── decisions/          ← archived DECs (status: archived)
│   │   │   └── invariants/         ← archived INVs (status: archived)
│   │   ├── canonical-map/
│   │   │   └── topics.yaml         ← topic → canonical-doc-path
│   │   ├── scope-index.yaml        ← file path → {decisions[], invariants[]} (mapper-generated, refreshed by GC sweep)
│   │   ├── brand/                  ← brand ground state (overview.md always injected at SessionStart)
│   │   ├── product/                ← product positioning + personas
│   │   ├── schema/                 ← stack-detected: ORM schema dump (Drizzle / Prisma / SQLAlchemy / etc.) — empty if no ORM
│   │   ├── routes/                 ← stack-detected: API route table (OpenAPI / NestJS / FastAPI / etc.) — empty if no routes
│   │   ├── events/                 ← stack-detected: event emitter+listener registry — empty if no event system
│   │   ├── quality-grades.yaml     ← per-module score from GC
│   │   └── glossary.md             ← terms (manual + GC-augmented)
│   ├── tasks/
│   │   ├── active/<task-id>/
│   │   │   ├── spec.md             ← original task spec (frontend-adapter ingested)
│   │   │   ├── spec.tightened.md   ← post-tightener; agent reads this
│   │   │   ├── status.yaml
│   │   │   ├── notes.md            ← agent free-text notes (append-only via cairn_append_run_note)
│   │   │   └── uat.md              ← persistent UAT state
│   │   ├── done/<task-id>/         ← terminal state, kept for history    HISTORICAL
│   │   └── archived/<task-id>/     ← user-archived (not auto)            HISTORICAL
│   ├── runs/                                                              GITIGNORED
│   │   ├── active/<run-id>/
│   │   │   ├── meta.json           ← {task_id, sha_pin, started_at, agent_role, model}
│   │   │   ├── prompt.md           ← rendered prompt
│   │   │   ├── events.jsonl        ← agent event stream
│   │   │   ├── commands.jsonl      ← shell commands run by agent
│   │   │   ├── attestation.yaml    ← agent's self-report (Layer B)
│   │   │   ├── diff.patch          ← unified diff at completion
│   │   │   ├── sensor-results.yaml ← per-sensor pass/fail
│   │   │   └── uat/                ← Playwright artifacts (see UAT_PIPELINE.md)
│   │   │       ├── recording.gif
│   │   │       ├── screenshots/
│   │   │       ├── console.log
│   │   │       ├── network.json
│   │   │       └── .uat-passed     ← SHA256 of bundle (evidence file)
│   │   └── terminal/<run-id>/      ← completed runs (auto-moved)         HISTORICAL
│   ├── inbox/                                                             GITIGNORED
│   │   └── <ts>-<source>.json      ← raw frontend-adapter ingress (Claude Code plugin in v0.1.0)
│   ├── transcripts/                                                       GITIGNORED
│   │   └── <ts>-<msg-id>.txt       ← voice transcripts when adapter ships audio
│   └── staleness/
│       ├── current.json            ← live drift snapshot                  GITIGNORED
│       └── log.jsonl               ← drift events                         GITIGNORED
```

Mirror checkout (separate, not in repo):

```
~/.cairn/repos/<project-slug>/        ← parallel git clone, Cairn operates here
~/.cairn/state/<project-slug>/        ← non-portable runtime state (PIDs, sockets)
~/.cairn/models/                      ← optional model files (reserved for future cache use)
```

---

## 2. Two-zone separation — canonical vs historical

### 2.1 Canonical zone (default agent visible)

Paths agents may grep/glob/find without restriction:

- `<repo>/AGENTS.md`, `<repo>/CLAUDE.md`
- `<repo>/.claude/{settings.json, agents/, skills/, rules/}`
- `<repo>/docs/**`
- `<repo>/.cairn/config/**`
- `<repo>/.cairn/ground/**` (excluding `_inbox/`)
- `<repo>/.cairn/tasks/active/**`

### 2.2 Historical zone (excluded from default reads)

- `<repo>/.cairn/runs/terminal/**`
- `<repo>/.cairn/tasks/done/**`
- `<repo>/.cairn/tasks/archived/**`
- `<repo>/.cairn/ground/decisions/_inbox/**`
- `<repo>/.cairn/runs/` (gitignored entirely; not even committed)

### 2.3 Enforcement — soft, three-layer (no PreToolUse)

PreToolUse-style tool-call interception is **rejected** (operator decision 2026-05-04 — see PRIMER §11). Two-zone separation is enforced softly through three composing layers:

1. **SessionStart instruction.** `.claude/settings.json` registers `cairn hook session-start`. The hook reads the SessionStart payload from stdin and emits an `additionalContext` block that names the historical paths and tells the agent default reads/grep/glob do not hit them. Spec at `docs/SESSIONSTART_SPEC.md`; implementation in `packages/cairn-core/src/session-start/`.
2. **Walker exclusion.** Every Cairn-internal walker (`ground/walk.ts` `walkCanonical`, `gc/stub-hits.ts` `walkSourceTree`) hardcodes historical roots into SKIP_DIRS. The Cairn-mediated reads (manifest build, GC, sensor sweeps) never see historical content. The agent's own `Read`/`Grep`/`Glob` tools are not interposed.

Why no PreToolUse: the hook runs on every tool call; a buggy hook bricks the session, false positives block legit work, and the failure mode is hard to debug. Soft enforcement is sufficient — agents naturally land in the canonical zone via Cairn's curated walkers.

---

## 3. Provenance frontmatter (required on load-bearing markdown)

Every load-bearing markdown file in canonical zone MUST carry:

```yaml
---
type: <one of: primer | integration-plan | layout | adr | invariant | spec | rule | research | gloss | other>
status: <one of: draft | accepted | superseded | archived | generated>
audience: <one of: ai-only | dual | human-only>
generated: <ISO 8601 timestamp; for hand-authored, use creation date>
verified-at: <ISO 8601 timestamp; updated by GC sweep when content matches expected hash>
source-commits:
  - <sha or "manual">
supersedes: <id-or-path or null>
---
```

CI gate (and cairn sensor):

```
load-bearing markdown in canonical zone WITHOUT frontmatter → fail
verified-at older than 30 days for status=accepted → flag (not block)
verified-at older than 60 days → block reads via hook escalation
```

The GC sweep updates `verified-at` automatically when:

- File hash unchanged AND linked source commits unchanged → bump verified-at to now
- Generated file: regenerated successfully → bump verified-at to now

This means simple "doc still right" checks don't require a human; GC handles them.

---

## 4. Decision file shape (`.cairn/ground/decisions/DEC-NNNN.md`)

```yaml
---
id: DEC-0042
title: actor_user_id denormalization on candidate_actions
type: adr
status: accepted
audience: dual
generated: 2026-05-01T18:23:00Z
verified-at: 2026-05-01T18:23:00Z
source-commits:
  - 9e3f4a2  # the run that confirmed this decision
decided_at: 2026-05-01
decided_by: operator
scope_globs:
  - core/src/dashboard/**
  - core/src/proactive-actions/**
  - core/src/drizzle/schema/candidate-actions.ts
supersedes: DB-2-original
superseded_by: null
assertions:
  - id: a1
    kind: schema_must_contain
    table: candidate_actions
    column: actor_user_id
    column_type: uuid
    nullable: true
  - id: a2
    kind: text_must_not_match
    pattern: "commandPayload->>'userId'"
    in_globs: ["core/src/dashboard/**"]
  - id: a3
    kind: index_must_exist
    table: candidate_actions
    columns: [actor_user_id]
    where: "actor_user_id IS NOT NULL"
  # Behavioral / contract kinds (per Codex audit Finding #6 — must-fix)
  - id: a4
    kind: query_must_filter_by
    orm: drizzle               # drizzle | typeorm | prisma | sqlalchemy | active_record | sqlx
    in_globs: ["core/src/dashboard/**/*.service.ts"]
    table: candidate_actions
    columns: [organization_id, actor_user_id]   # all must appear in WHERE for any SELECT/UPDATE/DELETE on the table
    operator: eq               # eq | in | between | is_not_null
    require_combination: and   # and | or
  - id: a5
    kind: route_must_have_guard
    in_globs: ["core/src/dashboard/**/*.controller.ts"]
    guard: OrgMembershipGuard  # one of the project's known auth guards
    require_on: [GET, POST, PATCH, DELETE]
  - id: a6
    kind: event_must_emit
    in_globs: ["core/src/dashboard/**/*.service.ts"]
    after_method: createCandidateAction
    event_key: "dashboard.candidate_action.created"
    payload_must_include: [organizationId, actorUserId, actionId]
  - id: a7
    kind: service_method_must_call
    in_globs: ["core/src/dashboard/**/*.service.ts"]
    in_method: createCandidateAction
    must_call: piiRedactionService.redact
    before_returning: true
human_review_hint: |
  Verify all CandidateAction emitters write actor_user_id natively.
related_invariants: [INV-0042]
---

# DEC-0042 — actor_user_id denormalization

## Summary

(decision body — full ADR text)

## Context
(...)

## Consequences
(...)
```

Compact ledger at `.cairn/ground/decisions/decisions.ledger.yaml`:

```yaml
# Always-loaded into agent system prompt (~50 lines for 100 decisions)
- id: DEC-0042
  title: actor_user_id denormalization on candidate_actions
  status: accepted
  scope_globs: [core/src/dashboard/**, core/src/proactive-actions/**]
  supersedes: DB-2-original
- id: DEC-0043
  title: ...
```

---

## 5. Invariant file shape (`.cairn/ground/invariants/INV-<N>.md`)

```yaml
---
id: INV-0042
title: No JSONB-userId filter in dashboard scope
type: invariant
status: active
audience: dual
generated: 2026-05-02T03:14:00Z
verified-at: 2026-05-02T03:14:00Z
source-run: run-abc123
source-decision: DEC-0042
introduced_for_bug: "Found in run-abc103: dashboard query used JSONB filter on commandPayload->>'userId', causing full-table scan."
sensor: cairn/scripts/check-inv0042-no-jsonb-userid-filter.ts
e2e: e2e/INV-0042_actor_user_id_denorm.spec.ts
naming_convention: "Tests must cite invariant ID — e.g., TestINV0042_RefundIdempotent."
---

# §INV-0042 — No JSONB-userId filter in dashboard scope

(invariant body — full text)
```

Compact ledger at `.cairn/ground/invariants/invariants.ledger.yaml` — same shape as decisions ledger.

---

## 6. Task file shape (`.cairn/tasks/active/<task-id>/`)

### 6.1 `spec.md` (raw operator input)

```yaml
---
id: TSK-2026-05-02-1
type: spec
status: tightening
audience: dual
generated: 2026-05-02T05:30:00Z
source: claude-code-session
source_session_id: "01HXPEXAMPLE0001"
intent: fix_issue
priority: 5
target_path_globs:
  - core/src/integrations/**
trust_class: code
---

# Add unique partial index on integration_oauth_tokens

(raw spec, possibly transcribed from voice)
```

### 6.2 `spec.tightened.md` (after Layer F)

```yaml
---
id: TSK-2026-05-02-1
type: spec-tightened
status: ready
audience: dual
generated: 2026-05-02T05:31:30Z
verified-at: 2026-05-02T05:31:30Z
source-spec: spec.md
tightener_model: claude-haiku-4-5-20251001
spec_quality_score: 9
ambiguities_resolved:
  - "What's the partial-index condition? → archived_at IS NULL (operator confirmed)"
in_scope_decisions: []
in_scope_invariants: []
existing_stub_overlap: []
acceptance_criteria:
  - core/drizzle/<migration>.sql contains CREATE UNIQUE INDEX with partial WHERE
  - sensor schema-drift passes
  - sensor lint passes
  - sensor tsc passes
---

# Tightened spec — add unique partial index

## What

Add a unique partial index `ux_integration_oauth_tokens_active_per_user` on `(provider, user_id) WHERE archived_at IS NULL` to the `integration_oauth_tokens` table.

## Why

(...)

## Sections agent must touch

- core/src/drizzle/schema/integrations.ts — add `uniqueIndex(...).where(...)`
- core/db-extensions/<file>.sql — partial-index DDL (Drizzle can't express partial in TS)
- migrations/<new>.sql — generated by `pnpm db:generate`

## Decisions / Discretion split

decisions:
  - Index name MUST be `ux_integration_oauth_tokens_active_per_user`
discretion:
  - Field order in the UNIQUE clause (consult existing convention if any)
```

### 6.3 `status.yaml`

```yaml
phase: ready_to_dispatch  # ready_to_dispatch | running | sensor_check | reviewer | uat | committing | succeeded | failed | halted
attempts: 0
last_event_at: 2026-05-02T05:31:30Z
queued_position: 1
related_run_ids: []
```

### 6.4 `uat.md`

```yaml
---
type: uat
status: pending  # pending | passing | passed | failed | blocked
generated: 2026-05-02T05:31:30Z
---

# UAT for TSK-2026-05-02-1

## Acceptance criteria checklist
- [ ] Migration produces valid SQL when applied to a fresh DB
- [ ] sensor `schema-drift` green
- [ ] sensor `lint` green

## Cold-start smoke (auto-injected — task touches `core/db-extensions/` or migration)
- [ ] `pnpm db:reset && pnpm db:migrate` succeeds without error

## Blocked-by
(empty unless environmental blockers — these never fold into Gaps)
```

---

## 7. Run file shape (`.cairn/runs/active/<run-id>/`)

Gitignored. Per-run scratch + outputs.

### 7.1 `meta.json`

```json
{
  "run_id": "run-abc123",
  "task_id": "TSK-2026-05-02-1",
  "agent_role": "&lt;project&gt;-fixer",
  "attempt": 1,
  "model": "claude-sonnet-4-6",
  "started_at": "2026-05-02T05:32:00Z",
  "finished_at": null,
  "phase": "streaming_turn",
  "sha_pin": "9e3f4a2",
  "branch_pin": "main",
  "mirror_path": "~/.cairn/repos/<project-slug>",
  "adapter_channel_id": "...",
  "adapter_thread_id": "...",
  "tokens_input": 0,
  "tokens_output": 0,
  "cost_usd": 0
}
```

### 7.2 `events.jsonl`

One JSON object per line. Append-only via `cairn_record_run_event` MCP. Shape:

```json
{ "ts": "2026-05-02T05:32:01Z", "seq": 1, "kind": "phase_transition", "from": "preparing_workspace", "to": "building_prompt" }
{ "ts": "2026-05-02T05:32:02Z", "seq": 2, "kind": "tool_use", "tool": "Read", "args": { "path": "core/src/drizzle/schema/integrations.ts" } }
{ "ts": "2026-05-02T05:32:05Z", "seq": 3, "kind": "tool_result", "tool": "Read", "result_summary": "loaded 247 lines" }
{ "ts": "2026-05-02T05:32:30Z", "seq": 4, "kind": "usage", "tokens_in": 8123, "tokens_out": 412 }
{ "ts": "2026-05-02T05:32:31Z", "seq": 5, "kind": "sensor_pass", "sensor": "lint" }
```

### 7.3 `attestation.yaml` (Layer B)

```yaml
---
run_id: run-abc123
task_id: TSK-2026-05-02-1
agent_role: &lt;project&gt;-fixer
emitted_at: 2026-05-02T05:38:00Z
---

delivered:
  - symbol: integration_oauth_tokens (schema)
    path: core/src/drizzle/schema/integrations.ts
    behavior: full
    sensors_passed: [lint, tsc, schema-drift]

deferred: []

known_limitations: []

todos_introduced: 0
stubs_introduced: 0

files_touched:
  - core/src/drizzle/schema/integrations.ts
  - core/db-extensions/40-integration-oauth-tokens-unique-partial.sql
  - core/drizzle/0157_integration_oauth_unique.sql

lines_added: 17
lines_removed: 0
```

### 7.4 `sensor-results.yaml`

```yaml
- sensor: lint
  status: pass
  duration_ms: 4231
- sensor: tsc
  status: pass
  duration_ms: 8412
- sensor: schema-drift
  status: pass
  duration_ms: 1100
- sensor: stub-pattern-catalog
  status: pass
  patterns_checked: 32
  hits: 0
- sensor: attestation-cross-check
  status: pass
  matched_claims: 5
- sensor: decision-assertions
  status: pass
  assertions_evaluated: 0  # no in-scope decisions for this diff
```

---

## 8. Manifest (`.cairn/ground/manifest.yaml`)

The continuously-updated index of canonical files. Refreshed by the GC sweep and post-commit hook.

```yaml
# regenerated by GC sweep + post-commit hook
# READ-ONLY for agents — they query MCP, not this file directly
generated: 2026-05-02T03:14:00Z
files:
  - path: AGENTS.md
    sha256: a1b2c3...
    classification: orientation
    audience: dual
    verified_at: 2026-05-02T03:00:00Z
  - path: .claude/rules/typescript-law.md
    sha256: ...
    classification: rule
    audience: dual
    verified_at: 2026-05-02T03:00:00Z
  - path: .cairn/ground/decisions/DEC-0042.md
    sha256: ...
    classification: decision
    audience: dual
    verified_at: 2026-05-01T18:23:00Z
    related_invariants: [INV-0042]
  - path: docs/engineering/api-map.md
    sha256: ...
    classification: generated
    audience: dual
    verified_at: 2026-05-02T03:14:00Z
    generator: pnpm openapi:generate
    source: core/openapi.json
```

---

## 9. Gitignore policy

`.gitignore` additions on Cairn adoption:

```
# Cairn runtime state
.cairn/runs/
.cairn/inbox/
.cairn/transcripts/
.cairn/staleness/log.jsonl
.cairn/staleness/current.json
.cairn/ground/decisions/_inbox/
```

---

## 9a. Cairn directory protection

`.cairn/` is owned exclusively by the Cairn system. AI sessions not running through Cairn must not write to it directly. This is enforced at three layers:

### Layer 1 — Instruction (`.claude/rules/cairn-protection.md`)

Written by `cairn init`. Auto-loaded by Claude Code in every session in this project. Content:

```markdown
# Cairn directory protection

.cairn/ is managed exclusively by the Cairn system.

NEVER write files directly to .cairn/ — not to any subdirectory,
not for any reason. This includes:
- Creating files in .cairn/ground/, .cairn/tasks/, .cairn/config/
- Moving files into this directory
- Editing any file inside this directory directly

To record a decision: use the cairn_record_decision MCP tool.
To create a task: use the cairn_task_create MCP tool or `cairn task` CLI.

If you are unsure where to put something, ask. Do not create ad-hoc folders
or files outside of the project's source tree.
```

This catches the common case: an AI session without Cairn sees `.cairn/` and starts putting things in it.

### Layer 2 — Pre-commit hook (`.git/hooks/pre-commit`)

Written by `cairn init`. Rejects any direct write to `.cairn/ground/` that doesn't come from the Cairn CLI:

```bash
#!/bin/sh
# Cairn directory protection — do not remove or modify

PROTECTED="^\.(cairn/ground|cairn/config|cairn/tasks)/"

if git diff --cached --name-only | grep -qE "$PROTECTED"; then
  if [ -z "$CAIRN_COMMIT" ]; then
    echo ""
    echo "  ✗ Cairn protection: direct writes to .cairn/ are not allowed."
    echo "    Use the Cairn CLI or MCP tools to modify these directories."
    echo "    If you are the Cairn system, set CAIRN_COMMIT=1."
    echo ""
    exit 1
  fi
fi
```

`CAIRN_COMMIT=1` is set by the Cairn process on all its commits. Regular git commits from any other source — including AI agents using the Write/Edit tools directly — are blocked.

`.cairn/runs/` and `.cairn/inbox/` are gitignored so they never reach commit stage.

### Layer 3 — GC orphan detection

GC's orphan pass scans for state-tracking files created outside `.cairn/`:
- Patterns: `REMEDIATION*.md`, `TODO*.md`, `PROGRESS*.md`, `FIXES*.md`, `PLANNING*.md`, `*.planning`, `.planning/`
- If found outside `.cairn/`: logs to attention queue for operator review

This is the cleanup net. Layers 1 and 2 prevent; Layer 3 cleans up what slips through.

### What the hook does NOT protect

`.cairn/runs/` (gitignored — agents can write here freely, runtime concern) and any files in the project source tree. Protection is scoped to the ground state directories only.

---

## 9b. Existing `docs/` folder adoption

When the project has an existing `docs/` folder, Cairn adopts it in place — no files move, nothing is deleted. Cairn takes ownership of its health.

### What "adoption" means

1. **Catalogued**: every file in `docs/` is added to the docs-index during `cairn init`
2. **Frontmatter added**: files without provenance frontmatter get a minimal header added during init phase 6 + refreshed by GC sweep (`type`, `status: draft`, `audience: dual`, `generated: <today>`, `verified-at: <today>`)
3. **Canonical-map seeded**: the init mapper proposes canonical-map entries for docs that look like authoritative references (architecture docs, rule docs, guides)
4. **Staleness flagged**: files that reference deleted symbols or paths are marked `needs-reverification` in the docs-index
5. **GC enrolled**: all `docs/` files are included in GC's five passes from init onward

### What adoption does NOT do

- Does not move or rename any file
- Does not delete anything
- Does not overwrite file content (only adds frontmatter if absent)
- Does not archive anything without explicit operator confirm (existing docs get a softer default — surface first, archive only on explicit confirm)

### Operator-facing init output

```
  Existing docs/ folder found — 12 files

  Adopting...
    ✓ ARCHITECTURE.md      — added to canonical-map (topic: architecture)
    ✓ API_GUIDE.md         — added to canonical-map (topic: api-surface)
    ✓ DEPLOYMENT.md        — added to docs-index
    ⚠ MOBILE_FLOWS.md      — references deleted paths (src/mobile/) — flagged for review
    ✓ 8 other files        — catalogued, frontmatter added

  All files remain in docs/. Cairn now tracks their health.
  Run `cairn attention` to review the flagged file.
```

### Ongoing control

After adoption, Cairn controls the `docs/` folder the same way it controls `.cairn/ground/`:
- GC keeps files fresh and honest
- New docs created by agents in `docs/` are automatically picked up by the next GC sweep
- Stale or orphaned docs are surfaced and archived on operator confirm
- The Cairn protection rule (§9a) does NOT apply to `docs/` — agents can write there freely, because that's where docs are supposed to go. Cairn just owns the health audit.

---

## 10. Hook surface (`.claude/settings.json`)

Locked direction (operator decision 2026-05-04): **no PreToolUse hooks.** Soft enforcement only.

| Hook | Matcher | Purpose |
|------|---------|---------|
| `SessionStart` | always | Inject curated state context per `docs/SESSIONSTART_SPEC.md`: two-zone reminder, decisions in scope, §INV invariants, current task, weakest modules from quality grades, pending decision drafts, MCP tool quick-reference. Implementation: `cairn hook session-start`. |
| `UserPromptSubmit` (planned, Phase 2) | always | Route operator's `/direction <text>` and free-text directives into `cairn-core`'s decision-capture pipeline. Not yet implemented. |
| `Stop` (planned, Phase 3) | always | Backprop trigger candidate on session end; defer until SessionStart + UserPromptSubmit are stable. |
| `PreToolUse` | — | **Rejected.** Two-zone separation is enforced via SessionStart instruction + walker exclusion. See PRIMER §11 anti-pattern entry. |
| `PostToolUse` | — | Not currently used. Frontmatter `verified-at` bumps happen via the GC sweep, not on every write. |

---

## 11. Init script — `npx @isaacriehm/cairn init <repo-dir>`

Implementation lives in `packages/cairn-core/src/init/`. Key outputs:

- Creates the directory tree above (templates/.cairn/, templates/.claude/, templates/.mcp.json copied via `seedCairnLayout`)
- Mechanical stack-signature detection (`detect.ts`) proposes initial sensor list, awaits operator confirm per sensor
- Init mapper (Tier 2) reads the repo summary and proposes `pilot_module` + `route_handler_globs` + `dto_globs` + `generator_source_globs` + `high_stakes_globs` + `off_limits_globs` + per-project sensor candidates; output applied to the `<slug>:` extension block in `workflow.md` and to `.cairn/config.yaml`
- Mechanical pass populates `.cairn/ground/manifest.yaml` and category extracts where generators apply
- Writes `.mcp.json` registering the Cairn MCP server (`cairn mcp serve`) and `.claude/settings.json` registering the SessionStart hook (`cairn hook session-start`)
- Phase 9/10 source-comment + rules-merge ingestion (Haiku-classified, deterministic walker + replacement)
- Phase 13 multi-dev install patches `package.json` `prepare` script for Node projects + emits hints for non-Node hosts

Result: a fresh `Cairn adopted` state with canonical surfaces marked, the MCP server registered, all hooks live, and the per-clone bootstrap recorded. **No PreToolUse hook is registered** — two-zone enforcement is soft (see §2.3).

---

## 12. Collaboration mode (per Codex audit Finding #13)

The "no branches, direct commits to main" stance is calibrated to a solo founder. To remain honest about portability, Cairn supports an explicit `collaboration_mode` setting in `.cairn/config/workflow.md`:

```yaml
---
collaboration_mode: solo  # solo | team
---
```

| Mode | Push policy | Auto-merge classes |
|------|-------------|--------------------|
| `solo` (default) | Direct commit to `main`; mirror checkout isolates the user's working tree | Per PRIMER §12.2 — safe-class auto, code-class operator-confirmed, high-stakes E2E-gated |
| `team` | Cairn opens PRs against `main` from a per-run branch (`cairn/run-<id>`); CI runs as gate; required reviewer can be Cairn's own reviewer subagent OR a real human (configurable) | Auto-merge only on safe-class + protected-branch admins approve via existing GitHub branch protection |

Operator MUST flip to `team` if they:

- Add a second collaborator
- Need protected-branch CI gating
- Want code review on Cairn-produced commits

Init script asks once at adoption; defaults to `solo` with a one-line warning on profile mismatch (e.g., a project with multiple committers in `git log --format=%aE | sort -u | wc -l > 1` defaults to `team`).

---

## 13. What this layout deliberately omits

- **Database** — no Drizzle, no SQLite, no Notion. All state on disk.
- **Per-tenant scoping** — Cairn is operator-side; no `organization_id` semantics.
- **Multi-user identity** — operator-allowlist is the entire auth model (whichever frontend adapter is active).
- **Branches / PRs in `solo` mode** — direct commit workflow (see PRIMER.md §10 anti-patterns). Branches re-enable in `team` mode per §12 above.
- **Multi-concurrent code-runs** — concurrency = 1 by design (single-task pipeline) regardless of mode.
- **Long-lived agent memory** — no claude-mem-style observation log; mechanical state is enough.
- **Vendor lock-in** — no Linear-specific files, no Notion-specific shape. Trackerless.
