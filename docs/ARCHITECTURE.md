---
type: architecture
status: locked
audience: dual
generated: 2026-05-05
---

# Cairn — Architecture (layered model)

> **This is a technical implementation spec.** If you're trying to *use*
> Cairn rather than modify it, start with the user guide:
> [Core concepts](guide/concepts.md).

Cairn is **state management + context loading for AI coding agents**. The
Claude Code plugin is the primary surface that adopters interact with; the
CLI provides bootstrap and debug entrypoints. Everything else is built on
top of a curated, queryable ground state at `.cairn/ground/`.

## §1 Three layers, five packages

```
┌────────────────────────────────────────────────────────────────────┐
│  FRONTEND (UX surface — pluggable)                                 │
│    cairn-frontend-claudecode   — Claude Code plugin (primary)      │
│    cairn-lens                  — VS Code / Cursor extension        │
└────────────────────────────────────────┬───────────────────────────┘
                                         │ MCP server + hooks
                                         │
┌────────────────────────────────────────▼───────────────────────────┐
│  CLI (bootstrap + debug)                                           │
│    cairn — `cairn init`, `cairn join`, `cairn hook <event>`,       │
│            `cairn doctor`, `cairn attention`, `cairn mcp serve`    │
└────────────────────────────────────────┬───────────────────────────┘
                                         │ depends on cairn-core
                                         │
┌────────────────────────────────────────▼───────────────────────────┐
│  CORE (state + context)                                            │
│    cairn-core  — MCP server, sensors, hook runners, init wizard,   │
│                  GC drift sweep, decision-capture (id allocator),  │
│                  source-comment + rules-merge ingestion,           │
│                  multi-dev install, claude subprocess wrapper.     │
│    cairn-state — ground-state schemas + cached read-only I/O.      │
│                  Imported by cairn-core and cairn-lens.            │
└────────────────────────────────────────────────────────────────────┘
```

Each layer installs independently. The minimum useful install is
`cairn-core` + the Claude Code plugin — adopters point Claude Code at the
plugin, the plugin invokes the CLI for hook runners and the MCP server, and
ground state lives in `.cairn/`.

## §2 Why this split

The load-bearing piece is the curated state layer. The plugin is the
primary frontend; the CLI is bootstrap + debug; everything is built on top
of the same ground state contract. Bundling them into one package would
force every adopter to pull the whole stack even if they only want the
plugin's daily-flow behaviour.

Concrete wins:

1. **Clear purpose.** "Cairn is the state + context-loading layer" is a
   sentence anyone can hold.
2. **Pluggable frontend.** A future adapter (web, IDE-other-than-VS-Code,
   etc.) implements the MCP surface + hook conventions; `cairn-core` does
   not change.
3. **Each package has its own smoke + typecheck cadence.** Changes to one
   layer do not force re-typecheck of another.
4. **The MCP surface is the public API.** What agents talk to is explicit
   and bounded.

## §3 Package contents

### 3.1 `cairn-core` — state + context layer

What lives here:

- `init/` — adoption wizard. Phase orchestration, mapper (chunked Sonnet),
  source-comment ingestion (Phase 9), rules merge (Phase 10), strip-replace
  primitives (Phase 12), multi-dev install (Phase 13). Visual rendering
  helpers + the four-question brand setup.
- `ground/` — `.cairn/ground/` schema + writers. Decisions ledger,
  invariants ledger, manifest, canonical-map, scope-index, drift events,
  frontmatter parsing, glob matching.
- `components/` — the fourth ground store (alongside decisions,
  invariants, canonical-map). `@cairn` source-header parse + collect +
  deterministic index render (`cairn-state`), the check sensor (the gate),
  the advisory audit, and the adoption trio (`9d-comp-walk` lists
  un-headered files → `9e-comp-annotate` dispatches `component-annotator`
  subagents that write headers into source → `9f-comp-emit` builds the
  index + drafts singleton §INVs). The `@cairn` headers in code are the
  committed source of truth; `.cairn/ground/components/` is the gitignored
  derived inventory.
- `mcp/` — MCP server. 29 typed tools (read, write-locked write,
  history-summarizer, init-phase orchestration, attention queue
  drains, task lifecycle, resume layer). Bootstrap-guard wraps every
  write tool with the `BOOTSTRAP_REQUIRED` envelope when a clone is
  unbootstrapped.
- `hooks/` — hook runner functions called by both the CLI subcommand
  (`cairn hook <event>`) and the bin entrypoints under `dist/hooks/`.
  SessionStart, SessionEnd, Stop, PostToolUse[Read|Grep|Glob|Write|Edit].
  Bypass-detection module.
- `gc/` — GC sweep (drift / completion-integrity / scope-coverage /
  quality-grades / citation-integrity / doc-source-drift / … /
  `entity-orphan`). `apply.ts` commits via `simple-git`; `canary.ts`
  post-batch integrity check. `entity-orphan` + `retire.ts` are the
  retirement OUT path: they walk ledger → code, archive provably-orphaned
  DEC/INV to `.cairn/ground/.archive/` (`archiveEntity`), and surface the
  ambiguous ones to cairn-attention. The autonomous daily tick auto-applies
  only the SAFE subset, canary-gated.
- `decision-capture/` — DEC id allocator + scanner. The `cairn_record_decision`
  MCP tool composes a draft on top of these.
- `sensors/` — Layer A (stub catalog), Layer C (structural,
  project-agnostic), decision-assertions, the diff-scoped `runSensorsOnDiff`
  sweep runner, and the remediation prompt body. Runs at pre-commit
  (staged) + CI (`--diff`). (Layer B attestation cross-check was removed —
  no production path emitted the attestation it depended on.)
- `session-start/` — `buildSessionStartContext()` composes the SessionStart
  hook payload. Priority-ordered truncation to token budget.
- `events/` — invalidation events writer + reader; per-session marker.
- `session/` — per-session state partition. resolveSessionId,
  ensureSessionDir, gcStaleSessions.
- `status-line/` — per-session status.json writer + Claude Code status-line
  reader.
- `claude/` — subprocess wrapper for `claude --print --output-format json
  --json-schema`. Used by mapper, source-comments classifier, rules-merge,
  docs-ingest, history summarizer.
- `join/` — per-clone bootstrap orchestrator. `runJoin` + `inspectJoinState`.
- `migrate/` — coded `.cairn/` migration registry. Ordered migrations keyed
  by `introducedIn`; `runMigrations` selects by semver vs the `cairn_version`
  pin (with a `detect()` idempotency backstop), applies the `safe` subset
  under `.migrate-lock`, surfaces `review` migrations, and stamps the pin.
  Runs at SessionStart, `cairn join`, MCP boot, and `cairn migrate`.
- `lock.ts` — per-write `flock` on `.cairn/.write-lock` for global writes.
- `logger.ts` — pino setup.

**Tier model.** Backend LLM calls flow through three tiers:
`haiku` (Tier 1, classifiers + summarizers), `sonnet` (Tier 2, the
mapper + reviewer subagent), `opus` (Tier 3, currently unused — kept
in the `ClaudeTier` union as an escape hatch). The earlier Tier-0
prompt-classifier and backend tightener modules were both purged in
v0.2.1; routing + tightening are now main-Claude judgment via the
cairn-direction skill, not backend calls.

### 3.2 `cairn` — umbrella + CLI

The CLI binary. Subcommands: `init`, `join`, `hook <event>`, `doctor`,
`fix`, `attention`, `gc`, `scope`, `mcp serve`, `status-line`. Each command
composes primitives from `cairn-core`. Hook runners are also exposed as
direct bin entrypoints under `cairn-core/dist/hooks/<event>.js` for
flexibility — the published plugin shells out to `cairn hook <event>`
instead so the binary stays the contract.

### 3.3 `cairn-frontend-claudecode` — Claude Code plugin

Plugin manifest, `.mcp.json` (registers `cairn mcp serve`), `hooks.json`
(SessionStart, SessionEnd, Stop, PostToolUse), skills (`cairn-adopt`,
`cairn-direction`, `cairn-attention`), agents (reviewer subagent), slash
commands (`/cairn-init`, `/cairn-direction`).

### 3.4 `cairn-lens` — VS Code / Cursor extension

Hover provider, inlay hints, CodeLens for inline §INV references and DEC
links — plus hover cards on `@cairn` component headers (`[S]` singleton
marker; amber drift when the header name ≠ the exported name). Read-only
consumer of the same ground state.

### 3.5 `cairn-state` — ground-state schemas + low-level I/O

Lightweight package that holds the Zod schemas for `.cairn/ground/`
(decisions, invariants, manifest, canonical-map, scope-index, component
registry), path
resolution helpers for `.cairn/`, cached ledger and task readers, and
the decoupled logger interface. Imported by `cairn-core` and
`cairn-lens` so the ground-state contract is one shared module — no
reimplementation across consumers.

## §4 The MCP surface — Cairn's public API

The MCP server (in `cairn-core`) is what agents talk to during a session.
From the agent's perspective, **the MCP is what Cairn IS**. Tools group
into:

- **Read — graph traversal** — `cairn_decision_get`,
  `cairn_in_scope` (unified path-glob lookup for DECs + INVs;
  filter via `types`), `cairn_invariant_get`,
  `cairn_canonical_for_topic`.
- **Read — search + retrieval** — `cairn_search`.
- **Read — component store** — `cairn_components_in_scope` (full in-scope
  inventory before UI work), `cairn_component_get`.
- **Read — historical (gated)** — `cairn_query_history` (only path to
  `.archive/`; LLM-summarized, never raw).
- **Write — append-only, per-write `flock`** — `cairn_record_decision`,
  `cairn_task_create`.
- **Write — retirement** — `cairn_retire_decision`,
  `cairn_retire_invariant` (archive to `.archive/`; not a hard delete).
- **Attention queue** — `cairn_resolve_attention`, `cairn_attention_dedup`.
- **Init pipeline** — `cairn_init_phase_*` (13 phases) +
  `cairn_init_resume`, `cairn_init_phases_8_9_10_parallel`.

See [`MCP_SURFACE.md`](MCP_SURFACE.md) for tool-by-tool schemas.

## §5 The plugin contract

Plugin entrypoints reduce to two surfaces:

1. **MCP server** — `cairn mcp serve` (registered in `.mcp.json`).
2. **Hook runners** — `cairn hook <event>` for SessionStart / SessionEnd /
   Stop / PostToolUse. Each prints Shape B JSON to stdout.

Plus three skills that auto-invoke under the right conditions:

- `cairn-adopt` — first-time adoption walk. SessionStart triggers it when
  `.cairn/` is missing.
- `cairn-direction` — daily flow. Auto-invokes on user message in an
  adopted project.
- `cairn-attention` — drains the pending-decisions queue. Auto-invokes
  when the Stop hook surfaces a non-empty hint.

See [`PLUGIN_ARCHITECTURE.md`](PLUGIN_ARCHITECTURE.md) for the full plugin
spec.

## §6 What's not in scope

- **No orchestration runtime.** The plugin's daily flow uses Claude Code's
  built-in subagent dispatch (`Task` tool); Cairn provides the spec
  tightener + reviewer prompt + sensors but does not run a separate
  process pool.
- **No alternative agent UX.** The plugin is the operator surface. CLI is
  for bootstrap and debug.
- **No remote infrastructure.** No hosted service, no telemetry beyond
  the local pino log file. Ground state is on disk; agent calls are local
  Claude Code subprocesses.
