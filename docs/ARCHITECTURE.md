---
type: architecture
status: locked
audience: dual
generated: 2026-05-05
---

# Cairn — Architecture (layered model)

Cairn is **state management + context loading for AI coding agents**. The
Claude Code plugin is the primary surface that adopters interact with; the
CLI provides bootstrap and debug entrypoints. Everything else is built on
top of a curated, queryable ground state at `.harness/ground/`.

## §1 Three layers, four packages

```
┌────────────────────────────────────────────────────────────────────┐
│  FRONTEND (UX surface — pluggable)                                 │
│    cairn-frontend-claudecode   — Claude Code plugin (primary)      │
│    cairn-frontend-stub         — In-memory test adapter            │
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
│    cairn-core — `.harness/ground/` writers, MCP server, sensors,   │
│                 hook runners, init wizard, GC drift sweep,         │
│                 decision-capture, source-comment + rules-merge     │
│                 ingestion, multi-dev install, claude wrapper +     │
│                 tier0 classifier. The Cairn.                       │
└────────────────────────────────────────────────────────────────────┘
```

Each layer installs independently. The minimum useful install is
`cairn-core` + the Claude Code plugin — adopters point Claude Code at the
plugin, the plugin invokes the CLI for hook runners and the MCP server, and
ground state lives in `.harness/`.

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
  source-comment ingestion (Phase 7b), rules merge (Phase 7c), strip-replace
  primitives (Phase 10), multi-dev install (Phase 12). Visual rendering
  helpers + the four-question brand setup.
- `ground/` — `.harness/ground/` schema + writers. Decisions ledger,
  invariants ledger, manifest, canonical-map, scope-index, drift events,
  frontmatter parsing, glob matching.
- `mcp/` — MCP server. 19 typed tools (read, write-locked write,
  history-summarizer). Bootstrap-guard wraps every write tool with the
  `BOOTSTRAP_REQUIRED` envelope when a clone is unbootstrapped.
- `hooks/` — hook runner functions called by both the CLI subcommand
  (`cairn hook <event>`) and the bin entrypoints under `dist/hooks/`.
  SessionStart, SessionEnd, Stop, PostToolUse[Read|Grep|Glob|Write|Edit].
  Bypass-detection module.
- `gc/` — GC sweep with five passes (drift / completion-integrity /
  scope-coverage / quality-grades / staleness). `apply.ts` commits via
  `simple-git`; `canary.ts` post-batch integrity check.
- `decision-capture/` — DEC id allocator + scanner. The `harness_record_decision`
  MCP tool composes a draft on top of these.
- `sensors/` — Layer A (stub catalog), Layer B (attestation), Layer D
  (structural project-agnostic), decision-assertions, runner, remediation
  prompt body.
- `session-start/` — `buildSessionStartContext()` composes the SessionStart
  hook payload. Priority-ordered truncation to token budget.
- `events/` — invalidation events writer + reader; per-session marker.
- `session/` — per-session state partition. resolveSessionId,
  ensureSessionDir, gcStaleSessions.
- `status-line/` — per-session status.json writer + Claude Code status-line
  reader.
- `tightener/` — spec quality gate. Tier-1 LLM call; scores task body,
  surfaces ambiguities, proposes tightened spec.
- `claude/` — subprocess wrapper for `claude --print --output-format json
  --json-schema`. Used by tightener, mapper, classifiers.
- `tier0/` — fast Haiku classifier (intent + activity-summary).
- `join/` — per-clone bootstrap orchestrator. `runJoin` + `inspectJoinState`.
- `lock.ts` — per-write `flock` on `.harness/.write-lock` for global writes.
- `frontend-types.ts` — `FrontendAdapter` contract for the test stub.
- `logger.ts` — pino setup.

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

### 3.4 `cairn-frontend-stub` — test adapter

In-memory `FrontendAdapter` for smokes. Records every dialog request +
update post; programmable response for dialog round-trips.

### 3.5 `cairn-lens` — VS Code / Cursor extension

Hover provider, inlay hints, CodeLens for inline §V references and DEC
links. Read-only consumer of the same ground state.

## §4 The MCP surface — Cairn's public API

The MCP server (in `cairn-core`) is what agents talk to during a session.
From the agent's perspective, **the MCP is what Cairn IS**. Tools group
into:

- **Read** — `harness_decision_get`, `harness_decisions_in_scope`,
  `harness_decisions_for_symbol`, `harness_invariant_get`,
  `harness_invariants_in_scope`, `harness_canonical_for_topic`,
  `harness_ground_get`, `harness_supersedes_chain`, `harness_search`,
  `harness_timeline`, `harness_get_full`, `harness_query_history`.
- **Write** (per-write `flock`) — `harness_record_decision`,
  `harness_record_run_event`, `harness_drop_task`, `harness_archive`,
  `harness_append`, `harness_ask_operator`.
- **Plugin-era resolution** — `harness_resolve_attention` resolves the
  inline A/B/C surface for DEC-draft accept / reject / edit, baseline-
  finding triage / suppress / defer, invalidation-event refresh /
  continue-under-old / abort.

See [`MCP_SURFACE.md`](MCP_SURFACE.md) for tool-by-tool schemas.

## §5 The plugin contract

Plugin entrypoints reduce to two surfaces:

1. **MCP server** — `cairn mcp serve` (registered in `.mcp.json`).
2. **Hook runners** — `cairn hook <event>` for SessionStart / SessionEnd /
   Stop / PostToolUse. Each prints Shape B JSON to stdout.

Plus three skills that auto-invoke under the right conditions:

- `cairn-adopt` — first-time adoption walk. SessionStart triggers it when
  `.harness/` is missing.
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
