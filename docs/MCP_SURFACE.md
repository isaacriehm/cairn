---
type: mcp-surface
status: draft-v4
audience: dual
generated: 2026-05-04
supersedes: MCP_SURFACE.md (draft-v3)
depends-on:
  - docs/PRIMER.md
  - docs/FILESYSTEM_LAYOUT.md
  - docs/ARCHITECTURE.md
---

# `harness-mcp` Server — Tool Surface

The MCP server exposes structured retrieval, append-only writes, and history-explicit access for any registered coding agent (Claude Code, Codex). Lives in `packages/harness-core/src/mcp/` and is started by `harness mcp serve` (stdio transport).

## Why MCP, not raw tools

| Problem | MCP fix |
|---------|---------|
| Freeform "search the docs" → LLM-as-search-engine, brittle | Structured graph traversal: agent traverses by id and path-glob, no fuzzy match |
| Edit tool requires Read first → wasted tokens for append-only | Append-only writes: no read required |
| Agent grep hits stale historical content | Hook + MCP gate; historical only via explicit `harness_query_history` |
| Agent invents file paths | Canonical-map lookup: `harness_canonical_for_topic("event-naming") → path + sha + verified-at` |
| Decisions get ignored across runs | Compact ledger always-loaded at session start; full content via id |

## Registration

Adopters register the server via `.mcp.json` (created by `harness init`):

```json
{
  "mcpServers": {
    "harness": {
      "command": "npx",
      "args": ["-y", "@devplusllc/harness", "mcp", "serve"]
    }
  }
}
```

`harness mcp serve` reads `--repo-root <path>` (defaults to `HARNESS_REPO_ROOT` env or `cwd`) and speaks MCP over stdio. Codex equivalent in `~/.codex/config`. Same binary serves both clients.

---

## Tool catalog (18 tools)

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
| `category` | string | One of: `schema`, `routes`, `events`, `quality_grades`, `glossary` |
| `key` | string | Optional. Category-specific filter (e.g. table name for `schema`, controller name for `routes`) |

Returns the generated extract for the category. Use this for bulk category reads (e.g. "give me the full schema"). For a specific named artifact by ID, use `harness_get_full`. For the path to the canonical doc on a topic, use `harness_canonical_for_topic`.

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

The summarizer's system prompt + JSON Schema live in `packages/harness-core/src/mcp/history/{prompt,schema}.ts` and the prompt id is version-locked at `harness.history_summarize.v1`. The `currently_canonical_pointer` field is **post-resolved by the harness, not the LLM**: the LLM emits a proposed `superseded_by` DEC-id, the server validates it against the on-disk decisions ledger, and only sets the pointer when a matching `.harness/ground/decisions/<id>.md` exists. Malformed or invented ids resolve to `null`. If the agent receives a `harness_query_history` response without `historical_only: true`, the response is treated as malformed and ignored.

The walker caps total bytes (default 200 KB) and file count (default 40) to keep summarizer prompts bounded; when the cap is hit, `truncated_walk: true` is returned and the `summary_caveat` includes guidance to refine `path_hint` / `since` / `until` and re-query. The default tier is `haiku` (per workflow.md `garbage_collector: 1` cousin); operators can override via the `--tier` flag if they enable it on their MCP server.

### Write tools — append-only, no read required

#### `harness_record_decision`

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

Drops to `.harness/ground/decisions/_inbox/<DEC-id>.draft.md`. Daemon picks it up, notifies operator via active frontend adapter for confirm. Operator confirm moves draft to canonical zone and updates `decisions.ledger.yaml`.

Errors: `DECISION_ID_TAKEN`, `INVALID_ASSERTION_KIND`, `SUPERSEDES_NOT_FOUND`.

#### `harness_archive`

| Field | Type | Notes |
|-------|------|-------|
| `path` | string | Required. Must exist in canonical zone |
| `reason` | string | Required. Saved to archive metadata |
| `archive_dir` | string | Optional override; default `.archive/<today>/` |

Moves a file from canonical zone to `.archive/<archive_dir>/<original_path>`. Idempotent. Records a `staleness/log.jsonl` event.

Errors: `PATH_NOT_FOUND`, `PATH_OUTSIDE_REPO`, `NOT_ALLOWED` (AGENTS.md, `.claude/`, locked paths).

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
| `harness_grep(query)` | Agents use Claude Code's native Grep + harness's canonical-zone walkers (which exclude `.archive` and other historical roots from SKIP_DIRS). An MCP grep would duplicate the agent's existing tool surface without adding access. |
| `harness_decision_update` | Decisions are append-only via supersedes chain. No in-place updates. |
| `harness_invariant_disable` | Invariants are superseded with new entries, not disabled. |
| `harness_run_create` / `harness_record_run_event` / `harness_drop_task` | Runtime concerns — run lifecycle and task queuing are owned by `harness-runtime`, not the core MCP surface. |
| `harness_ask_operator` | Runtime concern — blocking on operator input mid-run is an orchestrator responsibility, not a state-layer primitive. |
| `harness_append` | Direct-append to run artifact paths was removed; runtime writes to runs/ directly via fs, no MCP round-trip needed. |
| `harness_set_quality_grade` | GC daemon owns quality grades; agents don't write them. |
| `harness_modify_workflow` | `workflow.md` is operator-edited only; agents read via canonical extracts. |
| `harness_decision_update` | Decisions are append-only via supersedes chain. No in-place edits. |
| `harness_invariant_disable` | Invariants are superseded with new entries, not disabled. |

---

## Example agent flows

### Flow 1 — agent assigned a task that touches dashboard/

```
1. `harness hook session-start` injects decisions_in_scope[] + invariants_active[]
   summary into context (per docs/SESSIONSTART_SPEC.md)
2. Agent sees DEC-0042 in the rendered list ("actor_user_id denormalization on dashboard/")
3. Agent calls: harness_decision_get("DEC-0042") → full ADR + assertions
4. Agent calls: harness_invariants_in_scope(["core/src/dashboard/**"]) → [V0042]
5. Agent reads relevant code (canonical zone — harness walkers exclude historical paths)
6. Agent makes change
7. Agent emits `attestation.yaml` (runtime reads it directly from run dir)
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
packages/harness-core/src/mcp/
├── server.ts               ← MCP transport entry; routes tools to handlers
├── context.ts              ← per-server context (repoRoot + optional runId)
├── errors.ts               ← McpErrorCode enum + envelope shape
├── result.ts               ← wraps payloads as MCP CallToolResult
├── path-allowlist.ts       ← APPEND_ALLOWLIST, ARCHIVE_DENY, HISTORICAL_ZONE
├── schemas.ts              ← zod input schemas per tool
├── telemetry.ts            ← per-call mcp-calls.jsonl writer
├── history/
│   ├── walker.ts           ← .archive/ walker with path_hint + date window
│   ├── prompt.ts           ← Tier-1 summarizer system + user prompts
│   ├── schema.ts           ← JSON Schema for summarizer output
│   ├── summarizer.ts       ← end-to-end runQueryHistory; post-resolves canonical pointer
│   └── index.ts            ← barrel
└── tools/
    ├── decision-get.ts
    ├── decisions-in-scope.ts
    ├── decisions-for-symbol.ts
    ├── canonical-for-topic.ts
    ├── ground-get.ts
    ├── supersedes-chain.ts
    ├── invariant-get.ts
    ├── invariants-in-scope.ts
    ├── search.ts
    ├── timeline.ts
    ├── get-full.ts
    ├── query-history.ts
    ├── append.ts
    ├── record-decision.ts
    ├── record-run-event.ts
    ├── drop-task.ts
    ├── archive.ts
    └── ask-operator.ts
```

Started via `harness mcp serve` (CLI in `packages/harness/`). Stdio transport. Registered for Claude Code via the `.mcp.json` block above.
