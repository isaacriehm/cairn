---
type: mcp-surface
status: draft-v5
audience: dual
generated: 2026-05-07
supersedes: MCP_SURFACE.md (draft-v4)
depends-on:
  - docs/FILESYSTEM_LAYOUT.md
  - docs/ARCHITECTURE.md
---

# `cairn-mcp` Server — Tool Surface

> **This is a technical implementation spec.** If you're trying to *use*
> Cairn rather than modify it, start with the user guide:
> [Quick reference](guide/reference.md) for the everyday tool list, or
> [Working with decisions](guide/decisions.md) for query patterns.

The MCP server exposes structured retrieval, append-only writes, and history-explicit access for any registered coding agent (Claude Code, Codex). Lives in `packages/cairn-core/src/mcp/` and is started by `cairn mcp serve` (stdio transport).

## Why MCP, not raw tools

| Problem | MCP fix |
|---------|---------|
| Freeform "search the docs" → LLM-as-search-engine, brittle | Structured graph traversal: agent traverses by id and path-glob, no fuzzy match |
| Edit tool requires Read first → wasted tokens for append-only | Append-only writes: no read required |
| Agent grep hits stale historical content | Canonical-zone walkers exclude historical paths from SKIP_DIRS |
| Agent invents file paths | Canonical-map lookup: `cairn_canonical_for_topic("event-naming") → path + sha + verified-at` |
| Decisions get ignored across runs | Compact ledger always-loaded at session start; full content via id |

## Registration

Adopters register the server via `.mcp.json` (created by `cairn init`):

```json
{
  "mcpServers": {
    "cairn": {
      "command": "npx",
      "args": ["-y", "@isaacriehm/cairn", "mcp", "serve"]
    }
  }
}
```

`cairn mcp serve` reads `--repo-root <path>` (defaults to `CAIRN_REPO_ROOT` env or `cwd`) and speaks MCP over stdio. Codex equivalent in `~/.codex/config`. Same binary serves both clients.

---

## Tool catalog (32 tools)

Conventions:

- All tools take a single object argument validated with zod.
- All tools return structured JSON. No prose.
- Path-allowlist gating on every write tool.
- Errors return `{ error: { code, message, details } }` — never throw.

### Complete tool index

Source of truth: `packages/cairn-core/src/mcp/tools/index.ts` (`allTools`).

**Read — graph traversal (4)**

| Tool                        | What                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `cairn_decision_get`        | Full DEC by id (frontmatter + assertions + body markdown).                    |
| `cairn_in_scope`            | DEC + §INV summaries whose scope_globs overlap supplied path-globs. Pass `types: ["decision"]` or `["invariant"]` to filter. |
| `cairn_invariant_get`       | Full §INV by id.                                                              |
| `cairn_canonical_for_topic` | `topic → canonical_path + sha256 + verified_at`. Curated topic registry.      |

**Read — search + retrieval (1)**

| Tool           | What                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `cairn_search` | FTS over canonical-zone artifacts; compact index records (~50 tokens each). |

**Read — component store (2)**

| Tool                        | What                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `cairn_components_in_scope` | Full in-scope component inventory for the supplied path-globs — the entitled workspace(s) + any `[shared]` workspace, plus the OFF-LIMITS list. Single-app → the whole inventory. The "full slice read" the daily flow loads before UI work. |
| `cairn_component_get`       | One component's ledger entry + raw `@cairn` header (`@props`/`@example`) by name (optionally workspace-scoped). |

**Write — append-only (2)**

| Tool                    | What                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `cairn_record_decision` | Record a DEC — auto-accepts into the ledger by default (verify-then-accept; near-dup → `_inbox/` draft). Server allocates `DEC-NNNN`. |
| `cairn_task_create`     | Create `.cairn/tasks/active/<id>/` with `spec.tightened.md` + `status.yaml`. |

**Write — retirement (2)**

| Tool                      | What                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `cairn_retire_decision`   | Archive an accepted DEC that has rotted. Moves it to `.cairn/ground/.archive/`; not a hard delete. |
| `cairn_retire_invariant`  | Archive an active INV that no longer holds. Same archive semantics.                    |

**Write — plugin-era attention queue (5)**

| Tool                          | What                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| `cairn_resolve_attention`     | Resolve a single attention item (DEC draft / baseline finding / drift).   |
| `cairn_bulk_accept_attention` | Auto-promote high-confidence drafts before interactive triage.            |
| `cairn_attention_dedup`       | Cluster near-duplicate drafts by Jaccard ≥ 0.4.                            |
| `cairn_attention_serve`       | Spawn a local browser triage GUI when queue > 15.                         |
| `cairn_attention_wait`        | Block until the browser GUI emits resolutions or the operator cancels.    |

**Init pipeline (2)**

The 13-phase adoption pipeline lives behind a single `cairn_init_run`
dispatcher. The skill loops on `cairn_init_resume` → `cairn_init_run`
until `nextPhase === null`. Phase 8 (`8-docs-ingest`) internally fans
out to phases 8/9/10 in parallel and advances to `11-baseline`; the
skill doesn't need a separate code path for the parallel runner.

| Tool                | What                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| `cairn_init_resume` | Read `.cairn/init-state.json` and return the next phase id (or `null` when done).   |
| `cairn_init_run`    | Dispatch a specific phase by id (`{ phase, answer? }`). Persists state on success.  |

> **History.** Pre-v0.7.2 surface registered 13 per-phase tools
> (`cairn_init_phase_<id>`) plus a separate
> `cairn_init_phases_8_9_10_parallel` tool. They were collapsed into
> the umbrella above to cut MCP listing bloat (~5k tokens) and remove
> the skill's special-case branch for the parallel gate.

### Read tools — graph traversal

#### `cairn_decision_get`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Required. e.g., `"DEC-0042"` |

Returns:

```json
{
  "id": "DEC-0042",
  "title": "actor_user_id denormalization on candidate_actions",
  "status": "accepted",
  "scope_globs": [...],
  "supersedes": "DB-2-original",
  "superseded_by": null,
  "decided_at": "2026-05-01",
  "assertions": [
    { "id": "a1", "kind": "schema_must_contain", ... }
  ],
  "human_review_hint": "...",
  "related_invariants": ["INV-0042"],
  "body_markdown": "(full ADR text)"
}
```

Errors: `DECISION_NOT_FOUND`.

#### `cairn_in_scope`

| Field | Type | Notes |
|-------|------|-------|
| `path_globs` | string[] | Required. e.g., `["core/src/dashboard/**"]` |
| `types` | string[] | Optional. Filter to `["decision"]` or `["invariant"]`. Default: both. |
| `status` | string[] | Optional. For decisions, default `["accepted"]`; for invariants, default `["active"]`. |

Returns array of DEC + §INV summary records (no body) whose scope overlaps the supplied path-globs. Each record carries `kind: "decision" | "invariant"` so callers can split. Sorted by id.

#### `cairn_canonical_for_topic`

| Field | Type | Notes |
|-------|------|-------|
| `topic` | string | Required. From `.cairn/ground/canonical-map/topics.yaml` known set |

Returns:

```json
{
  "topic": "event-naming",
  "canonical_path": ".claude/rules/event-naming.md",
  "sha256": "...",
  "verified_at": "2026-05-02T03:00:00Z",
  "audience": "dual"
}
```

Errors: `TOPIC_NOT_REGISTERED` — agent should not invent topics; topic registry is curated.

#### `cairn_invariant_get`

Same shape as `cairn_decision_get` but for `.cairn/ground/invariants/INV-<N>.md`. Returns `id, title, status, source-run, source-decision, sensor, e2e, body_markdown`.

### Read tools — component store

#### `cairn_components_in_scope`

| Field | Type | Notes |
|-------|------|-------|
| `path_globs` | string[] | Required. The repo-relative paths the task touches. |

Resolves the workspace(s) the globs touch by longest-prefix match against
each workspace's `componentDirs`, then returns that workspace's inventory
plus any `[shared]` workspace's, plus the `off_limits` name list of
isolated workspaces. Single-app → the whole inventory. This is the "full
slice read" (port invariant 1): the agent loads the complete in-scope
inventory before UI work — no per-component retrieval. Models on
`cairn_in_scope`. Source of truth is the `@cairn` headers in code, collected
live, so the gitignored derived index never has to be current.

#### `cairn_component_get`

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Required. The `@cairn` export name. |
| `workspace` | string | Optional. Disambiguates a name reused across workspaces. |

Returns one component's ledger entry + the raw header so the agent reads
`@props` / `@example` before importing. Returns `COMPONENT_NOT_FOUND` when
no component carries the name. Models on `cairn_invariant_get`.

### Read tools — 3-layer progressive retrieval

#### `cairn_search`

| Field | Type | Notes |
|-------|------|-------|
| `query` | string | Required |
| `scope` | string[] | Optional path-globs |
| `kinds` | string[] | Optional. Restrict to `decision`, `invariant`, `task`, `run`, `doc`, `manifest` |
| `limit` | int | Default 20, max 50 |

Returns compact index records (~50 tokens each):

```json
[
  { "id": "DEC-0042", "kind": "decision", "title": "actor_user_id denormalization", "score": 0.91 },
  { "id": "INV-0042", "kind": "invariant", "title": "No JSONB-userId filter", "score": 0.88 }
]
```

Backed by FTS over the ground/. No LLM.

### Write tools — append-only, no read required

#### `cairn_record_decision`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Optional; server generates next `DEC-NNNN` if absent |
| `title` | string | Required |
| `summary` | string | Required |
| `scope_globs` | string[] | Required |
| `supersedes` | string | Optional |
| `assertions` | object[] | Optional; validated against 11-kind schema |
| `human_review_hint` | string | Optional |
| `body_markdown` | string | Optional; inferred from title+summary if absent |
| `target` | `"inbox"` \| `"accepted"` | Optional; omit for the default auto-accept path |

**Auto-accept by default** (see PLUGIN_ARCHITECTURE.md §7.6). When `target`
is omitted and `decisions.auto_accept` is not `false`, the decision is
verified (assertions schema-valid — already enforced — and the title not a
near-duplicate of an accepted DEC) and written straight to the canonical
zone `.cairn/ground/decisions/<DEC-id>.md` with `auto_accepted: true`;
`decisions.ledger.yaml` updates atomically under the per-write `flock`. The
human review checkpoint is the committed PR diff.

A near-duplicate falls back to `.cairn/ground/decisions/_inbox/<DEC-id>.draft.md`,
which the cairn-attention skill surfaces inline at the next assistant turn
for accept / reject / edit. An explicit `target: "inbox"` always drafts;
`target: "accepted"` always direct-accepts (skips the dedup gate). The
response reports `auto_accepted` and, on dedup fallback, a `note`.

Errors: `DECISION_ID_TAKEN`, `INVALID_ASSERTION_KIND`, `SUPERSEDES_NOT_FOUND`.

#### `cairn_retire_decision` / `cairn_retire_invariant`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Required. `DEC-<hash>` / `INV-<hash>` of an entity in the active ledger |
| `reason` | string | Optional. Stamped into the archived frontmatter |

The OUT path for the ground ledger. Retirement = **archive, never hard-delete**: the entity moves to `.cairn/ground/.archive/{decisions,invariants}/`, its `status` flips to `archived` (with `archived_at` + `archived_reason`), and the active ledger + SoT cache are rebuilt so it drops from `cairn_in_scope` and Layer A matching. A lingering `§DEC-/§INV-` cite degrades to an `orphaned_citation` GC finding rather than a dangling reference.

This is the shared apply primitive the autonomous `entity-orphan` GC pass and the cairn-attention "retire" action both invoke.

Errors: `DECISION_NOT_FOUND`, `INVARIANT_NOT_FOUND`, `RETIRE_FAILED`.

---

## Validation rules

All tool inputs validated with zod at server entry. Invalid input returns `{ error: { code: "VALIDATION_FAILED", message, details: <zod issues> } }`. Server never crashes on bad input.

## Failure modes

| Mode | Server response |
|------|-----------------|
| Tool not registered | `TOOL_NOT_FOUND` |
| Schema validation fail | `VALIDATION_FAILED` with zod details |
| Path outside repo | `PATH_OUTSIDE_REPO` (security gate) |
| Path in historical zone (read tools) | `PATH_HISTORICAL_USE_QUERY_HISTORY` |
| Path not in allowlist (write tools) | `PATH_NOT_ALLOWED` |
| Underlying file not found | `FILE_NOT_FOUND` |
| Long-running operation timeout | `OPERATION_TIMEOUT` |

## Telemetry

Every tool call writes a row to `.cairn/runs/active/<run-id>/mcp-calls.jsonl`:

```json
{ "ts": "...", "tool": "cairn_decision_get", "args": {...}, "result_kind": "ok|error", "result_size": 412, "duration_ms": 12 }
```

Used post-run for cost analysis and to detect agents over-querying (a smell).

## Compatibility surface

| Client | Status |
|--------|--------|
| Claude Code | Primary client; settings.json registration |
| Codex | Secondary client; same server, same tools |
| Future | Generic MCP transport — any MCP-aware client |

---

## What is NOT in this surface

Deliberate omissions, with reasons:

| Omitted | Reason |
|---------|--------|
| `cairn_grep(query)` | Agents use Claude Code's native Grep + Cairn's canonical-zone walkers. An MCP grep would duplicate the agent's existing tool surface without adding access. |
| `cairn_decision_update` | Decisions are append-only via supersedes chain. No in-place edits — to remove one, `cairn_retire_decision` archives it. |
| `cairn_invariant_disable` | Invariants are superseded with new entries, not disabled in place. To remove a rotted one, `cairn_retire_invariant` archives it. |
| `cairn_run_create` / `cairn_record_run_event` / `cairn_drop_task` | Runtime concerns — run lifecycle and task queuing are owned by `cairn-runtime`, not the core MCP surface. |
| `cairn_ask_operator` | Runtime concern — blocking on operator input mid-run is an orchestrator responsibility, not a state-layer primitive. |
| `cairn_append` | Direct-append to run artifact paths was removed; runtime writes to runs/ directly via fs, no MCP round-trip needed. |
| `cairn_set_quality_grade` | The GC sweep owns quality grades; agents don't write them. |
| `cairn_modify_workflow` | `workflow.md` is operator-edited only; agents read via canonical extracts. |

---

## Example agent flows

### Flow 1 — agent assigned a task that touches dashboard/

```
1. `cairn hook session-start` injects decisions_in_scope[] + invariants_active[]
   summary into context (per docs/SESSIONSTART_SPEC.md)
2. Agent sees DEC-0042 in the rendered list ("actor_user_id denormalization on dashboard/")
3. Agent calls: cairn_decision_get("DEC-0042") → full ADR + assertions
4. Agent calls: cairn_in_scope({path_globs:["core/src/dashboard/**"], types:["invariant"]}) → [INV-0042]
5. Agent reads relevant code (canonical zone — Cairn walkers exclude historical paths)
6. Agent makes change
7. Agent emits `attestation.yaml` (runtime reads it directly from run dir)
8. Agent emits attestation.yaml
9. Sensors run; decision-assertions sensor evaluates a1, a2, a3 against diff
```

### Flow 2 — agent unsure what doc to consult on event-naming

```
1. Agent calls: cairn_canonical_for_topic("event-naming")
2. Returns: { canonical_path: ".claude/rules/event-naming.md", sha, verified_at }
3. Agent reads that path. No fuzzy match. No "is this still the rule?" investigation.
```

### Flow 3 — operator issued a direction change inline (Claude Code plugin)

```
1. Operator types prompt in Claude Code chat
2. cairn-direction skill engages on the operator message (verb-led OR
   bug report OR observation per its when_to_use trigger gate)
3. Skill gathers in-scope context (cairn_in_scope), asks ≤3 clarifying
   questions per round, tightens the spec via cairn_task_create
4. Reviewer subagent (after dispatch) calls cairn_record_decision → DEC-0099
   verifies (assertions valid, not a near-dup) and AUTO-ACCEPTS into
   .cairn/ground/decisions/DEC-0099.md (auto_accepted: true); emits an
   invalidation event; future sessions see DEC-0099. Review rides the PR diff.
   (Had DEC-0099 been a near-duplicate, it would instead land as an _inbox/
   draft and Step 5 below would run.)
5. [dedup-fallback / explicit-inbox only] Stop hook surfaces inline:
   "Review DEC-0099 draft? [a] accept [b] reject [c] edit" → operator picks
   → cairn-attention calls cairn_resolve_attention → server moves draft to
   canonical.
```

---

## Implementation outline

```
packages/cairn-core/src/mcp/
├── serve.ts                ← MCP transport entry; routes tools to handlers
├── context.ts              ← per-server context (repoRoot + optional runId)
├── errors.ts               ← McpErrorCode enum + envelope shape
├── result.ts               ← wraps payloads as MCP CallToolResult
├── path-allowlist.ts       ← APPEND_ALLOWLIST, ARCHIVE_DENY, HISTORICAL_ZONE
├── telemetry.ts            ← per-call mcp-calls.jsonl writer
└── tools/
    ├── index.ts                  ← `allTools` array (single source of truth)
    ├── types.ts                  ← `ToolDef` shape
    ├── decision-get.ts
    ├── decisions-in-scope.ts
    ├── decisions-for-symbol.ts
    ├── canonical-for-topic.ts
    ├── ground-get.ts
    ├── supersedes-chain.ts
    ├── invariant-get.ts
    ├── invariants-in-scope.ts
    ├── search.ts
    ├── record-decision.ts
    ├── task-create.ts
    ├── reject-candidate.ts
    ├── resolve-attention.ts
    ├── bulk-accept-attention.ts
    ├── attention-dedup.ts
    ├── attention-restore.ts
    ├── attention-serve.ts
    ├── attention-wait.ts
    ├── align-drain.ts
    └── init-phases.ts            ← `initPhaseTools` (13 phases) + `initResumeTool` + `initParallel8910Tool`
```

Started via `cairn mcp serve` (CLI in `packages/cairn/`). Stdio transport. Registered for Claude Code via the `.mcp.json` block above.

To add a new tool: define a `ToolDef` in `tools/<name>.ts`, import + push into `allTools` in `tools/index.ts`. The server picks it up automatically — no separate registration step.
