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

# Filesystem Layout — Disk-only state for the harness

Replaces the prior Postgres design. Everything lives on disk. Two-zone canonical/historical separation. Hook-enforced. Portable to any project via `npx @devplusllc/harness init`.

## 0. Decision summary (locked)

| Concern | Decision |
|---------|----------|
| Primary state | Filesystem only — markdown + YAML + JSONL |
| Database | None |
| Notion (as **state**) | None. Filesystem owns state. (Per Codex audit Finding #1: this is distinct from the frontend-adapter use; see next row.) |
| Notion (as **frontend adapter**) | Supported. Operator's friend uses Notion as their preferred operator console. Adapter consumes the same uniform task/run/UAT bundle as Discord and CLI. Not v0 default; built lazily when needed. |
| Concurrency model | Single-task FIFO; mirror checkout isolation |
| Branching | None — direct commits to main |
| User checkout protection | Harness operates only in mirror at `~/.local/harness/repos/<project>/` |
| Two zones | `canonical` (default agent visible) / `historical` (`.archive/` — only via explicit MCP) |
| Provenance | YAML frontmatter required on every load-bearing markdown |
| Append-only writes | Via `harness-mcp` tools — no read-before-write penalty |

---

## 1. Top-level layout in any harness-adopted repo

The layout below is **stack-agnostic**. Subdirectories under `.harness/ground/{schema,routes,events}/` are populated only when the operator's project has a generator that produces them — the init mapper proposes generators per detected stack signature (Drizzle / Prisma / SQLAlchemy → schema dump; OpenAPI / NestJS / FastAPI → routes table; project-defined event registry → events). Projects without those concerns simply have empty/missing directories; the harness layout itself doesn't change. Likewise `inbox/`, `transcripts/`, and `tasks/active/<id>/spec.md` are populated by whichever frontend adapter is active (CLI / Discord / Notion / future web); the layout stores no adapter-specific structure.

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
├── .harness/                       ← the harness's own state              MIXED
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
│   │   │   ├── V0001.md            ← §V invariant (monotonic, never reused)
│   │   │   └── invariants.ledger.yaml
│   │   ├── canonical-map/
│   │   │   └── topics.yaml         ← topic → canonical-doc-path
│   │   ├── scope-index.yaml        ← file path → {decisions[], invariants[]} (mapper-generated, daemon-maintained)
│   │   ├── brand/                  ← brand ground state (overview.md always injected at SessionStart)
│   │   ├── product/                ← product positioning + personas
│   │   ├── capabilities/           ← skills.yaml, mcp-tools.yaml, snippets.yaml
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
│   │   │   ├── notes.md            ← agent free-text notes (append-only via harness_append_run_note)
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
│   │   └── <ts>-<source>.json      ← raw frontend-adapter ingress (CLI / Discord / Notion / web)
│   ├── transcripts/                                                       GITIGNORED
│   │   └── <ts>-<msg-id>.txt       ← voice transcripts when adapter ships audio
│   └── staleness/
│       ├── current.json            ← live drift snapshot                  GITIGNORED
│       └── log.jsonl               ← drift events                         GITIGNORED
└── .archive/                                                              CANONICAL (committed)
    ├── README.md                   ← explains the quarantine
    └── <YYYY-MM-DD>/               ← daily quarantine drops
        └── ... (mirrors prior path of archived file)
```

Mirror checkout (separate, not in repo):

```
~/.local/harness/repos/<project-slug>/      ← parallel git clone, harness operates here
~/.local/harness/state/<project-slug>/      ← non-portable runtime state (PIDs, sockets)
~/.local/harness/models/                    ← optional model files (e.g. whisper.cpp when voice adapter installed)
```

---

## 2. Two-zone separation — canonical vs historical

### 2.1 Canonical zone (default agent visible)

Paths agents may grep/glob/find without restriction:

- `<repo>/AGENTS.md`, `<repo>/CLAUDE.md`
- `<repo>/.claude/{settings.json, agents/, skills/, rules/}`
- `<repo>/docs/**`
- `<repo>/.harness/config/**`
- `<repo>/.harness/ground/**` (excluding `_inbox/`)
- `<repo>/.harness/tasks/active/**`

### 2.2 Historical zone (excluded from default reads)

- `<repo>/.archive/**`
- `<repo>/.harness/runs/terminal/**`
- `<repo>/.harness/tasks/done/**`
- `<repo>/.harness/tasks/archived/**`
- `<repo>/.harness/ground/decisions/_inbox/**`
- `<repo>/.harness/runs/` (gitignored entirely; not even committed)

### 2.3 Enforcement — soft, three-layer (no PreToolUse)

PreToolUse-style tool-call interception is **rejected** (operator decision 2026-05-04 — see PRIMER §11). Two-zone separation is enforced softly through three composing layers:

1. **SessionStart instruction.** `.claude/settings.json` registers `harness hook session-start`. The hook reads the SessionStart payload from stdin and emits an `additionalContext` block that names the historical paths and tells the agent default reads/grep/glob do not hit them. Spec at `docs/SESSIONSTART_SPEC.md`; implementation in `packages/harness-core/src/session-start/`.
2. **Walker exclusion.** Every harness-internal walker (`ground/walk.ts` `walkCanonical`, `gc/stub-hits.ts` `walkSourceTree`) hardcodes `.archive` and other historical roots into SKIP_DIRS. The harness-mediated reads (manifest build, GC, sensor sweeps) never see archive content. The agent's own `Read`/`Grep`/`Glob` tools are not interposed.
3. **`harness_query_history` MCP tool.** The only sanctioned path to consult archive content. Walks `.archive/` matched by `path_hint` + `since`/`until`, runs a Tier-1 (Haiku) summarizer over the matched files, returns structured per-claim records with source citations and supersedes-pointers (resolved against the decisions ledger). Raw stale content never enters the agent's context — only the summary does. Implementation in `packages/harness-core/src/mcp/history/`.

Why no PreToolUse: the hook runs on every tool call; a buggy hook bricks the session, false positives block legit work, and the failure mode is hard to debug. Soft enforcement is sufficient because (a) agents naturally land in the canonical zone via the harness's curated walkers, and (b) `harness_query_history` covers the legitimate "I need to consult history" path without an interception layer.

### 2.4 What agents CAN do in historical zone

| Operation | Allowed? | Mechanism |
|-----------|----------|-----------|
| Direct `Read`/`Grep`/`Glob` of `.archive/` | Tool-permitted, but harness walkers don't surface these paths and the SessionStart instruction tells the agent not to. Soft enforcement — convention plus tooling, not interception. |
| `harness_query_history(scope, question)` | Yes — Tier-1 summarizer, returns structured claims with supersedes-pointers; raw stale content never enters context |
| `harness_archive(path, reason)` | Yes — moves canonical → archive (one-way) |

---

## 3. Provenance frontmatter (required on load-bearing markdown)

Every load-bearing markdown file in canonical zone MUST carry:

```yaml
---
type: <one of: primer | integration-plan | layout | adr | invariant | spec | rule | research | gloss | other>
status: <one of: draft | accepted | superseded | archived | generated>
audience: <one of: ai-only | dual | human-only>
generated: <ISO 8601 timestamp; for hand-authored, use creation date>
verified-at: <ISO 8601 timestamp; updated by daemon when content matches expected hash>
source-commits:
  - <sha or "manual">
supersedes: <id-or-path or null>
---
```

CI gate (and harness sensor):

```
load-bearing markdown in canonical zone WITHOUT frontmatter → fail
verified-at older than 30 days for status=accepted → flag (not block)
verified-at older than 60 days → block reads via hook escalation
```

The grounding daemon updates `verified-at` automatically when:

- File hash unchanged AND linked source commits unchanged → bump verified-at to now
- Generated file: regenerated successfully → bump verified-at to now

This means simple "doc still right" checks don't require a human; the daemon does them.

---

## 4. Decision file shape (`.harness/ground/decisions/DEC-NNNN.md`)

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
decided_by: discord:isaac
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
related_invariants: [V0042]
---

# DEC-0042 — actor_user_id denormalization

## Summary

(decision body — full ADR text)

## Context
(...)

## Consequences
(...)
```

Compact ledger at `.harness/ground/decisions/decisions.ledger.yaml`:

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

## 5. Invariant file shape (`.harness/ground/invariants/V<N>.md`)

```yaml
---
id: V0042
title: No JSONB-userId filter in dashboard scope
type: invariant
status: active
audience: dual
generated: 2026-05-02T03:14:00Z
verified-at: 2026-05-02T03:14:00Z
source-run: run-abc123
source-decision: DEC-0042
introduced_for_bug: "Found in run-abc103: dashboard query used JSONB filter on commandPayload->>'userId', causing full-table scan."
sensor: harness/scripts/check-v0042-no-jsonb-userid-filter.ts
e2e: e2e/V0042_actor_user_id_denorm.spec.ts
naming_convention: "Tests must cite invariant ID — e.g., TestV0042_RefundIdempotent."
---

# §V0042 — No JSONB-userId filter in dashboard scope

(invariant body — full text)
```

Compact ledger at `.harness/ground/invariants/invariants.ledger.yaml` — same shape as decisions ledger.

---

## 6. Task file shape (`.harness/tasks/active/<task-id>/`)

### 6.1 `spec.md` (raw operator input)

```yaml
---
id: TSK-2026-05-02-1
type: spec
status: tightening
audience: dual
generated: 2026-05-02T05:30:00Z
source: discord:voice
source_message_id: "1234567890"
source_channel: task-add-oauth-unique-index
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

## 7. Run file shape (`.harness/runs/active/<run-id>/`)

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
  "mirror_path": "/Users/user/.local/harness/repos/<project-slug>",
  "adapter_channel_id": "...",
  "adapter_thread_id": "...",
  "tokens_input": 0,
  "tokens_output": 0,
  "cost_usd": 0
}
```

### 7.2 `events.jsonl`

One JSON object per line. Append-only via `harness_record_run_event` MCP. Shape:

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

## 8. Manifest (`.harness/ground/manifest.yaml`)

The grounding daemon's continuously-updated index of canonical files.

```yaml
# regenerated by `harness watch` on file change
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
  - path: .harness/ground/decisions/DEC-0042.md
    sha256: ...
    classification: decision
    audience: dual
    verified_at: 2026-05-01T18:23:00Z
    related_invariants: [V0042]
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

`.gitignore` additions on harness adoption:

```
# harness runtime state
.harness/runs/
.harness/inbox/
.harness/transcripts/
.harness/staleness/log.jsonl
.harness/staleness/current.json
.harness/ground/decisions/_inbox/
```

`.archive/` is NOT gitignored — it's committed history.

---

## 9a. Harness directory protection

`.harness/` and `.archive/` are owned exclusively by the Harness system. AI sessions not running through Harness must not write to them directly. This is enforced at three layers:

### Layer 1 — Instruction (`.claude/rules/harness-protection.md`)

Written by `harness init`. Auto-loaded by Claude Code in every session in this project. Content:

```markdown
# Harness directory protection

.harness/ and .archive/ are managed exclusively by the Harness system.

NEVER write files directly to .harness/ or .archive/ — not to any subdirectory,
not for any reason. This includes:
- Creating files in .harness/ground/, .harness/tasks/, .harness/config/
- Creating files in .archive/ or any subdirectory
- Moving files into either directory
- Editing any file inside either directory directly

To record a decision: use the harness_record_decision MCP tool.
To archive a file: use the harness_archive MCP tool or `harness archive <path>` CLI.
To create a task: use the harness_drop_task runtime tool or `harness task` CLI.

If you are unsure where to put something, ask. Do not create ad-hoc folders
or files outside of the project's source tree.
```

This catches the common case: an AI session without Harness sees `.harness/` and starts putting things in it.

### Layer 2 — Pre-commit hook (`.git/hooks/pre-commit`)

Written by `harness init`. Rejects any direct write to `.harness/ground/` or `.archive/` that doesn't come from the Harness CLI:

```bash
#!/bin/sh
# Harness directory protection — do not remove or modify

PROTECTED="^\.(harness/ground|harness/config|harness/tasks|archive)/"

if git diff --cached --name-only | grep -qE "$PROTECTED"; then
  if [ -z "$HARNESS_COMMIT" ]; then
    echo ""
    echo "  ✗ Harness protection: direct writes to .harness/ or .archive/ are not allowed."
    echo "    Use the Harness CLI or MCP tools to modify these directories."
    echo "    If you are the Harness system, set HARNESS_COMMIT=1."
    echo ""
    exit 1
  fi
fi
```

`HARNESS_COMMIT=1` is set by the harness process on all its commits. Regular git commits from any other source — including AI agents using the Write/Edit tools directly — are blocked.

`.harness/runs/` and `.harness/inbox/` are gitignored so they never reach commit stage.

### Layer 3 — GC orphan detection

GC's orphan pass scans for state-tracking files created outside `.harness/`:
- Patterns: `REMEDIATION*.md`, `TODO*.md`, `PROGRESS*.md`, `FIXES*.md`, `PLANNING*.md`, `*.planning`, `.planning/`
- If found outside `.harness/`: moves to `.archive/<today>/rogue-artifacts/`, commits, logs to attention queue

This is the cleanup net. Layers 1 and 2 prevent; Layer 3 cleans up what slips through.

### What the hook does NOT protect

`.harness/runs/` (gitignored — agents can write here freely, runtime concern) and any files in the project source tree. Protection is scoped to the ground state directories only.

---

## 9b. Existing `docs/` folder adoption

When the project has an existing `docs/` folder, Harness adopts it in place — no files move, nothing is deleted. Harness takes ownership of its health.

### What "adoption" means

1. **Catalogued**: every file in `docs/` is added to the docs-index during `harness init`
2. **Frontmatter added**: files without provenance frontmatter get a minimal header added by the daemon (`type`, `status: draft`, `audience: dual`, `generated: <today>`, `verified-at: <today>`)
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

  All files remain in docs/. Harness now tracks their health.
  Run `harness attention` to review the flagged file.
```

### Ongoing control

After adoption, Harness controls the `docs/` folder the same way it controls `.harness/ground/`:
- GC keeps files fresh and honest
- New docs created by agents in `docs/` are automatically picked up by the daemon
- Stale or orphaned docs are surfaced and archived on operator confirm
- The harness protection rule (§9a) does NOT apply to `docs/` — agents can write there freely, because that's where docs are supposed to go. Harness just owns the health audit.

---

## 10. Hook surface (`.claude/settings.json`)

Locked direction (operator decision 2026-05-04): **no PreToolUse hooks.** Soft enforcement only.

| Hook | Matcher | Purpose |
|------|---------|---------|
| `SessionStart` | always | Inject curated state context per `docs/SESSIONSTART_SPEC.md`: two-zone reminder, decisions in scope, §V invariants, current task, weakest modules from quality grades, pending decision drafts, MCP tool quick-reference. Implementation: `harness hook session-start`. |
| `UserPromptSubmit` (planned, Phase 2) | always | Route operator's `/direction <text>` and free-text directives into `harness-core`'s decision-capture pipeline. Not yet implemented. |
| `Stop` (planned, Phase 3) | always | Backprop trigger candidate on session end; defer until SessionStart + UserPromptSubmit are stable. |
| `PreToolUse` | — | **Rejected.** Two-zone separation is enforced via SessionStart instruction + walker exclusion + `harness_query_history` MCP escape. See PRIMER §11 anti-pattern entry. |
| `PostToolUse` | — | Not currently used. Frontmatter `verified-at` bumps happen via the GC sweep, not on every write. |

---

## 11. Init script — `npx @devplusllc/harness init <repo-dir>`

Implementation lives in `packages/harness-core/src/init/`. Key outputs:

- Creates the directory tree above (templates/.harness/, templates/.archive/, templates/.claude/, templates/.mcp.json copied via `seedHarnessLayout`)
- Mechanical stack-signature detection (`detect.ts`) proposes initial sensor list, awaits operator confirm per sensor
- Init mapper (Tier 2) reads the repo summary and proposes `pilot_module` + `route_handler_globs` + `dto_globs` + `generator_source_globs` + `high_stakes_globs` + `off_limits_globs` + per-project sensor candidates; output applied to the `<slug>:` extension block in `workflow.md` and to `.harness/config.yaml`
- Mechanical pass populates `.harness/ground/manifest.yaml` and category extracts where generators apply
- Writes `.mcp.json` registering the harness MCP server (`harness mcp serve`) and `.claude/settings.json` registering the SessionStart hook (`harness hook session-start`)
- Prompts for Discord guild + bot token; creates category structure (📋 / 🟢 / 📦)
- Detects Ollama; prompts to install if missing
- E2E setup probes (`setup:uat-browsers`, `setup:uat-sql`, `setup:uat-docker`) gated behind a now/defer/skip operator dialog

Result: a fresh `harness adopted` state with canonical surfaces marked, the MCP server registered, the SessionStart hook live, and the daemon ready to start. **No PreToolUse hook is registered** — two-zone enforcement is soft (see §2.3).

---

## 12. Collaboration mode (per Codex audit Finding #13)

The "no branches, direct commits to main" stance is calibrated to a solo founder. To remain honest about portability, the harness supports an explicit `collaboration_mode` setting in `.harness/config/workflow.md`:

```yaml
---
collaboration_mode: solo  # solo | team
---
```

| Mode | Push policy | Auto-merge classes |
|------|-------------|--------------------|
| `solo` (default) | Direct commit to `main`; mirror checkout isolates the user's working tree | Per PRIMER §12.2 — safe-class auto, code-class operator-confirmed, high-stakes E2E-gated |
| `team` | Harness opens PRs against `main` from a per-run branch (`harness/run-<id>`); CI runs as gate; required reviewer can be the harness's own reviewer subagent OR a real human (configurable) | Auto-merge only on safe-class + protected-branch admins approve via existing GitHub branch protection |

Operator MUST flip to `team` if they:

- Add a second collaborator
- Need protected-branch CI gating
- Want code review on harness-produced commits

Init script asks once at adoption; defaults to `solo` with a one-line warning on profile mismatch (e.g., a project with multiple committers in `git log --format=%aE | sort -u | wc -l > 1` defaults to `team`).

---

## 13. What this layout deliberately omits

- **Database** — no Drizzle, no SQLite, no Notion. All state on disk.
- **Per-tenant scoping** — harness is operator-side; no `organization_id` semantics.
- **Multi-user identity** — operator-allowlist is the entire auth model (whichever frontend adapter is active).
- **Branches / PRs in `solo` mode** — direct commit workflow (see PRIMER.md §10 anti-patterns). Branches re-enable in `team` mode per §12 above.
- **Multi-concurrent code-runs** — concurrency = 1 by design (single-task pipeline) regardless of mode.
- **Long-lived agent memory** — no claude-mem-style observation log; mechanical state is enough.
- **Vendor lock-in** — no Linear-specific files, no Notion-specific shape. Trackerless.
