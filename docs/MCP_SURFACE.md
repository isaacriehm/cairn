---
type: mcp-surface
status: draft-v2
audience: dual
generated: 2026-05-02
depends-on:
  - docs/orchestration/PRIMER.md
  - docs/orchestration/FILESYSTEM_LAYOUT.md
---

# `harness-mcp` Server — Tool Surface

The MCP server exposes structured retrieval, append-only writes, and history-explicit access for any registered coding agent (Claude Code, Codex). Built into the `harness/` workspace as a long-lived process, started by `harness run`.

## Why MCP, not raw tools

| Problem | MCP fix |
|---------|---------|
| Freeform "search the docs" → LLM-as-search-engine, brittle | Structured graph traversal: agent traverses by id and path-glob, no fuzzy match |
| Edit tool requires Read first → wasted tokens for append-only | Append-only writes: no read required |
| Agent grep hits stale historical content | Hook + MCP gate; historical only via explicit `harness_query_history` |
| Agent invents file paths | Canonical-map lookup: `harness_canonical_for_topic("event-naming") → path + sha + verified-at` |
| Decisions get ignored across runs | Compact ledger always-loaded at session start; full content via id |

## Registration

`.claude/settings.json` mcp block:

```json
{
  "mcpServers": {
    "harness-mcp": {
      "command": "node",
      "args": ["./harness/dist/mcp/server.js"],
      "transport": "stdio"
    }
  }
}
```

Codex equivalent in `~/.codex/config`. Same server binary serves both clients.

---

## Tool catalog (16 tools)

Conventions:

- All tools take a single object argument validated with zod.
- All tools return structured JSON. No prose.
- Path-allowlist gating on every write tool.
- Errors return `{ error: { code, message, details } }` — never throw.

### Read tools — graph traversal

#### `harness_decision_get`

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
  "related_invariants": ["V0042"],
  "body_markdown": "(full ADR text)"
}
```

Errors: `DECISION_NOT_FOUND`.

#### `harness_decisions_in_scope`

| Field | Type | Notes |
|-------|------|-------|
| `path_globs` | string[] | Required. e.g., `["core/src/dashboard/**"]` |
| `status` | string[] | Optional. Default `["accepted"]`; allow `["accepted","superseded"]` for full history |

Returns array of decision summary records (no body) sorted by `decided_at` desc.

#### `harness_decisions_for_symbol`

| Field | Type | Notes |
|-------|------|-------|
| `file` | string | Repo-relative path |
| `symbol` | string | e.g., `"DashboardService.list"` |

Returns decisions whose `scope_globs` overlap the file path AND whose body explicitly mentions the symbol. Smaller result than path-glob alone.

#### `harness_canonical_for_topic`

| Field | Type | Notes |
|-------|------|-------|
| `topic` | string | Required. From `.harness/ground/canonical-map/topics.yaml` known set |

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

#### `harness_ground_get`

| Field | Type | Notes |
|-------|------|-------|
| `category` | string | One of: `schema`, `routes`, `events`, `quality_grades`, `glossary`, `manifest` |
| `key` | string | Optional. Category-specific (e.g., for `schema`: table name; for `routes`: controller name) |

Returns the relevant generated extract.

#### `harness_supersedes_chain`

| Field | Type | Notes |
|-------|------|-------|
| `decision_id` | string | Required |

Returns the chain forward to current binding decision:

```json
[
  { "id": "DB-2-original", "status": "superseded", "supersedes": null },
  { "id": "DB-2-revised", "status": "superseded", "supersedes": "DB-2-original" },
  { "id": "DEC-0042", "status": "accepted", "supersedes": "DB-2-revised" }
]
```

#### `harness_invariant_get`

Same shape as `harness_decision_get` but for `.harness/ground/invariants/V<N>.md`. Returns `id, title, status, source-run, source-decision, sensor, e2e, body_markdown`.

#### `harness_invariants_in_scope`

Same shape as `harness_decisions_in_scope`, returns invariant summaries.

### Read tools — 3-layer progressive retrieval

#### `harness_search`

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
  { "id": "V0042", "kind": "invariant", "title": "No JSONB-userId filter", "score": 0.88 }
]
```

Backed by FTS over the ground/. No LLM.

#### `harness_timeline`

| Field | Type | Notes |
|-------|------|-------|
| `scope` | string[] | Optional path-globs |
| `since` | string | ISO 8601 |
| `until` | string | ISO 8601; default now |
| `kinds` | string[] | Optional |

Returns chronologically ordered events relevant to the scope window. Useful for "what happened to integrations/ this week" without burning tokens on file reads.

#### `harness_get_full`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Required |
| `kind` | string | One of: `decision`, `invariant`, `task`, `run` |

Returns the full content of the named artifact. Used after `harness_search` / `harness_timeline` narrows the candidates. Reads the canonical zone only.

### Read tools — historical zone (gated)

#### `harness_query_history`

| Field | Type | Notes |
|-------|------|-------|
| `scope` | string | Free-text description (e.g., "early decision about JSONB index that was reverted") |
| `path_hint` | string | Optional path or glob inside `.archive/` |
| `since` | string | Optional ISO 8601 |
| `until` | string | Optional ISO 8601 |

The ONLY way agents see `.archive/`. The MCP server reads matching historical files itself, runs an LLM summarization (Tier 1), and returns structured **historical-only** claims with mandatory canonical cross-check pointers (per Codex audit Finding #4):

```json
{
  "historical_only": true,
  "claims": [
    {
      "claim": "Project considered using a JSONB expression index on commandPayload->>'userId' for dashboard CandidateAction queries.",
      "as_of": "2026-04-23",
      "source_path": ".archive/2026-05-pre-harness/REVIEW_DECISIONS.md",
      "source_lines": "320-410",
      "superseded_by": "DEC-0042",
      "currently_canonical_pointer": ".harness/ground/decisions/DEC-0042.md",
      "warning": "This claim is HISTORICAL. Verify against the canonical pointer before acting."
    }
  ],
  "summary_caveat": "All claims are dated and superseded-tagged. Do not treat any line above as current truth. Cross-reference DEC-0042 for current binding decision.",
  "summarizer_model": "claude-haiku-4-5-20251001",
  "summarizer_prompt_id": "harness.history_summarize.v1"
}
```

Raw stale content NEVER enters the agent's context. Each summarized claim carries its own provenance, supersedes-tag, and a forward pointer to the currently-canonical artifact. This:

- Eliminates the "agent reads both stale and live, hallucinates the truth" failure mode (raw stale never enters context)
- Prevents the secondary failure mode (the summary itself becomes a vector for stale claims) by mandating per-claim datestamps + supersedes pointers
- Forces the agent to cross-check via `harness_decision_get(superseded_by)` or `harness_canonical_for_topic(...)` before acting on any historical claim

The summarizer prompt template is committed at `.harness/config/prompts/history_summarize.v1.md` and version-locked. If the agent receives a `harness_query_history` response without `historical_only: true` and `superseded_by` fields populated, the response is treated as malformed and ignored.

### Write tools — append-only, no read required

#### `harness_append`

| Field | Type | Notes |
|-------|------|-------|
| `path` | string | Required. MUST be in path-allowlist |
| `content` | string | Required |
| `newline_separator` | bool | Default `true` |

Path-allowlist (server-side, not agent-controllable):

- `.harness/runs/active/<run-id>/events.jsonl`
- `.harness/runs/active/<run-id>/commands.jsonl`
- `.harness/staleness/log.jsonl`
- `.harness/inbox/` (system-only; agent rarely uses)

Errors: `PATH_NOT_ALLOWED`, `RUN_NOT_FOUND` (when path implies a run id that doesn't exist).

#### `harness_record_decision`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Optional; if absent, server generates next `DEC-NNNN` |
| `title` | string | Required |
| `summary` | string | Required |
| `scope_globs` | string[] | Required |
| `supersedes` | string | Optional |
| `assertions` | object[] | Optional; if present, must validate against schema |
| `human_review_hint` | string | Optional |
| `body_markdown` | string | Optional; if absent, body inferred from title+summary |
| `target` | string | One of `inbox` (default; awaits 🟢 confirm) or `accepted` (operator-only override; not used by agents) |

Drops to `.harness/ground/decisions/_inbox/<DEC-id>.draft.md` by default. Operator confirms via Discord 🟢 to move to canonical zone.

Errors: `DECISION_ID_TAKEN`, `INVALID_ASSERTION_KIND`, `SUPERSEDES_NOT_FOUND`.

#### `harness_record_run_event`

| Field | Type | Notes |
|-------|------|-------|
| `run_id` | string | Required |
| `event` | object | Required. `{ kind, payload }` |

Appends to `.harness/runs/active/<run_id>/events.jsonl`. Server fills `ts` and `seq`. Used by orchestrator's agent-runner; agents may also use it for self-reporting.

#### `harness_drop_task`

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Required |
| `body` | string | Required |
| `intent` | string | One of: `run_pilot`, `review_module`, `fix_issue`, `eval`, `staleness_scan`, `unknown` |
| `target_path_globs` | string[] | Optional |
| `priority` | int | Optional, default 5 |
| `parent_task_id` | string | Optional |
| `source` | string | Default `agent_spawned` |

Creates `.harness/tasks/active/<task-id>/spec.md` with frontmatter. Used by spec-planner subagent to chain spec → fix tasks. Operator-issued tasks come via Discord, not this tool.

#### `harness_archive`

| Field | Type | Notes |
|-------|------|-------|
| `path` | string | Required. Must currently exist in canonical zone |
| `reason` | string | Required. Will be saved to archive metadata |
| `archive_dir` | string | Optional override; default `.archive/<today>/` |

Moves a file from canonical zone to `.archive/<archive_dir>/<original_path>`. Idempotent (re-archive a no-op). Records a `staleness/log.jsonl` event. Re-running on already-archived target returns success without touching files.

Errors: `PATH_NOT_FOUND`, `PATH_OUTSIDE_REPO`, `NOT_ALLOWED` (e.g., AGENTS.md, .claude/, brand guidelines).

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
| Daemon temporarily unavailable | `DAEMON_UNAVAILABLE`; agent should retry once |
| Long-running operation timeout | `OPERATION_TIMEOUT` |

## Telemetry

Every tool call writes a row to `.harness/runs/active/<run-id>/mcp-calls.jsonl`:

```json
{ "ts": "...", "tool": "harness_decision_get", "args": {...}, "result_kind": "ok|error", "result_size": 412, "duration_ms": 12 }
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
| `harness_grep(query)` | Agents should use Claude Code's native Grep with PreToolUse hook gating; MCP grep would duplicate. |
| `harness_decision_update` | Decisions are append-only via supersedes chain. No in-place updates. |
| `harness_invariant_disable` | Invariants are superseded with new entries, not disabled. |
| `harness_run_create` | Orchestrator owns run lifecycle; agents don't create runs. |
| `harness_set_quality_grade` | GC daemon owns quality grades; agents don't write them. |
| `harness_modify_workflow` | `WORKFLOW.md` is operator-edited only; agents read via canonical extracts. |

---

## Example agent flows

### Flow 1 — agent assigned a task that touches dashboard/

```
1. SessionStart hook injects decisions.ledger.yaml + invariants.ledger.yaml
2. Agent sees DEC-0042 in ledger ("actor_user_id denormalization on dashboard/")
3. Agent calls: harness_decision_get("DEC-0042") → full ADR + assertions
4. Agent calls: harness_invariants_in_scope(["core/src/dashboard/**"]) → [V0042]
5. Agent reads relevant code (canonical zone, hook allows)
6. Agent makes change
7. Agent calls: harness_record_run_event(run_id, { kind: "phase_transition", to: "finishing" })
8. Agent emits attestation.yaml
9. Sensors run; decision-assertions sensor evaluates a1, a2, a3 against diff
```

### Flow 2 — agent unsure what doc to consult on event-naming

```
1. Agent calls: harness_canonical_for_topic("event-naming")
2. Returns: { canonical_path: ".claude/rules/event-naming.md", sha, verified_at }
3. Agent reads that path. No fuzzy match. No "is this still the rule?" investigation.
```

### Flow 3 — operator issued a direction change in Discord

```
1. discord ingress writes raw message to .harness/inbox/
2. Tier-0 classifier flags as direction-change
3. Tier-1 decision-extractor produces structured candidate
4. Server calls: harness_record_decision({ ..., target: "inbox" }) → DEC-0099 draft created
5. Bot posts confirm dialog to Discord
6. Operator 🟢
7. Server moves draft to canonical; daemon regenerates ledger; future runs see DEC-0099
```

### Flow 4 — agent investigating a historical pattern

```
1. Agent's query: "did we ever consider using JSONB indexes for this?"
2. Agent calls: harness_query_history({ scope: "JSONB index for user-scoped CandidateAction queries" })
3. Server reads matching .archive/ files, summarizes via Tier-1 LLM
4. Returns: { summary, sources: [...] }
5. Agent's context contains ONLY the summary, never raw stale content
```

---

## Implementation outline

```
harness/src/mcp/
├── server.ts               ← MCP transport entry; routes tools to handlers
├── tools/
│   ├── decision-get.ts
│   ├── decisions-in-scope.ts
│   ├── decisions-for-symbol.ts
│   ├── canonical-for-topic.ts
│   ├── ground-get.ts
│   ├── supersedes-chain.ts
│   ├── invariant-get.ts
│   ├── invariants-in-scope.ts
│   ├── search.ts
│   ├── timeline.ts
│   ├── get-full.ts
│   ├── query-history.ts
│   ├── append.ts
│   ├── record-decision.ts
│   ├── record-run-event.ts
│   ├── drop-task.ts
│   └── archive.ts
├── schemas/                 ← zod schemas per tool
├── path-allowlist.ts
└── telemetry.ts
```

Single binary: `node harness/dist/mcp/server.js`. Stdio transport. Started as subprocess by `harness run` and registered for Claude Code via settings.json.
