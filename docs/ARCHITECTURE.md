---
type: architecture
status: draft-v2
audience: dual
generated: 2026-05-04
supersedes: docs/_history/INTEGRATION_PLAN.md
---

# Harness — Architecture (layered model)

Harness is **state management + context loading for AI coding agents**. Orchestration runtime, sensor sweeps, mirror checkouts, UAT pipelines, and frontend adapters are *consumers* built on top of the state layer — not part of its core.

## 1. Three layers, four packages

```
┌────────────────────────────────────────────────────────────────────┐
│  FRONTEND (UX adapter — pluggable, opt-in)                         │
│    packages/harness-frontend-discord  — Discord adapter            │
│    packages/harness-frontend-stub     — In-memory test adapter     │
│    packages/harness-frontend-cli      — Terminal adapter (default) │
│    (future: harness-frontend-notion, …)                            │
└────────────────────────────────────────┬───────────────────────────┘
                                         │ FrontendAdapter contract
                                         │ (DialogSpec, PostUpdate,
                                         │  ApprovalBundle, …)
                                         │
┌────────────────────────────────────────▼───────────────────────────┐
│  RUNTIME (orchestration consumer)                                  │
│    packages/harness-runtime — orchestrator, FIFO queue, mirror     │
│                               checkout, Claude Code dispatcher,    │
│                               sensor sweep, reviewer subagent,     │
│                               UAT pipeline, backprop, watchdog.    │
│                               Adapter-agnostic.                    │
└────────────────────────────────────────┬───────────────────────────┘
                                         │ depends on harness-core
                                         │
┌────────────────────────────────────────▼───────────────────────────┐
│  CORE (state + context)                                            │
│    packages/harness-core   — `.harness/ground/` writers, MCP       │
│                              server (15 tools), grounding daemon,  │
│                              init wizard, GC drift sweep,          │
│                              decision-capture, stub catalog,       │
│                              decision-assertion evaluator,         │
│                              provenance frontmatter, two-zone      │
│                              separation, spec tightener,           │
│                              claude wrapper + tier0 classifier.    │
│                              The Harness.                          │
└────────────────────────────────────────────────────────────────────┘
```

**Each layer installs independently.** A project that just wants the state layer + Claude Code integration installs `harness-core` only. Adding `harness-runtime` enables the full GSD execution loop. Frontend adapters are installed via `harness install <adapter>`.

## 2. Why this split

The load-bearing thing is the curated state layer. Orchestration, UAT, and frontend UX are consumers of it. Bundling them together forces every adopter to pull the full stack even if they only want Claude Code + ground state.

Concrete wins:

1. **Clearer purpose.** "Harness is the state + context-loading layer" is a sentence anyone can hold.
2. **Adopters can pick what they want.** Core only for minimal Claude Code integration. Core + runtime for full GSD execution. Adapters are opt-in.
3. **Frontend pluggability is real.** Adding a new adapter doesn't touch the orchestrator — it implements `FrontendAdapter` from core.
4. **Each package has its own smoke + typecheck + version cadence.** Changes to one layer don't force re-typecheck of another.
5. **The MCP surface is the public API.** What agents talk to is explicit and bounded.

## 3. Package contents

### 3.1 `harness-core` — the state + context layer

What lives here:
- `init/` — adoption wizard. `detect.ts` (mechanical stack signatures), `walker.ts` (gitignore-aware repo summary), `mapper.ts` (Tier-2 LLM proposing sensors, generators, `<slug>:` block), `seed.ts` (template copy + `{{var}}` substitution), `workflow-block.ts` (round-trip the `<slug>:` extension block), `prompts.ts` (`@inquirer/prompts` wrappers: `squareIntoSquareHole`, `freeTextWithDefault`, `secretInput`, `editYaml`).
- `ground/` — `.harness/ground/` schema + writers. `walk.ts` (canonical-zone walker; hardcodes `.archive` + historical roots to SKIP_DIRS), `glob.ts`, `paths.ts`, `manifest.ts`, `ledgers.ts` (decisions + invariants ledger writers), `quality-grades.ts`, `drift.ts`, `frontmatter.ts` (provenance parsing + freshness eval), `schemas.ts` (zod for all 11 `DecisionAssertion` kinds + `DecisionFrontmatter` + `InvariantFrontmatter` + `ManifestEntry` + `QualityGrade`).
- `mcp/` — MCP server. 15 typed tools (see `MCP_SURFACE.md`). Subdir `mcp/history/` houses the `query_history` summarizer.
- `daemon/` — grounding daemon. File watcher (chokidar), generator runner, manifest rebuilder, docs-index maintainer, GC cron. See `DAEMON_SPEC.md`.
- `gc/` — five-pass GC sweep. `sweep.ts` composes passes; `apply.ts` commits via `simple-git`; `canary.ts` post-batch integrity check; `classify.ts` (safe / code / high-stakes per project globs); `profiles/` (stack-profile generator registry).
- `decision-capture/` — operator direction text → typed candidate decision. `extractor.ts` (Tier-1) + `refinement.ts` (assertion proposer) + `writer.ts` (draft → accepted) + `capture.ts` (end-to-end) + `id.ts` (monotonic DEC-id allocator).
- `sensors/` — Layers A, B, D, decision-assertions, runner, remediation. `catalog.ts`, `stub-catalog.ts` (Layer A), `attestation.ts` (Layer B), `structural.ts` (Layer D — project-agnostic), `decisions.ts` (11-kind evaluator), `diff.ts`, `runner.ts`, `remediation.ts`.
- `session-start/` — `buildSessionStartContext()` composes the SessionStart hook payload. Priority-ordered truncation to token budget. See `SESSIONSTART_SPEC.md`.
- `tightener/` — spec quality gate. Tier-1 LLM call; scores task body, surfaces ambiguities, proposes tightened spec.
- `claude/` — subprocess wrapper for `claude --print --output-format json --json-schema`. Used by tightener, mapper, decision-capture, history summarizer.
- `tier0/` — Ollama local classifier (intent + activity-summary).
- `mirror/` — parallel git clone management at `~/.local/harness/repos/<slug>/`. Clone + sync + push + dirty-overlap pre-check.
- `profiles/` — stack-profile registry for GC generator-drift detection.
- `frontend-types.ts` — `FrontendAdapter` contract + shared types. Imported by both runtime and all frontend adapters.
- `inbox.ts` — `writeInboxRow()` appends normalized events to `.harness/inbox/`. Adapter ingress drops here; runtime tails.
- `prompt.ts` — minimal template renderer for `workflow.md` prompt body (`{{var}}`, `{{#each}}`).
- `logger.ts` — pino setup.

### 3.2 `harness-runtime` — orchestration consumer

What lives here:
- `orchestrator/` — the `Orchestrator` class. FIFO queue, dispatch, lifecycle (queued → tightening → blocked → prepping → running → sensing → reviewing → uat → succeeded|failed). Imports tightener / mapper from core; imports adapters via the FrontendAdapter contract.
- `mirror/` — clone, sync (fetch+reset --hard origin/main), push, dirty-overlap pre-check.
- `runner/` — claude subprocess invocation as the implementer (vs the one-shot calls in core). Streams events to events.jsonl.
- `sensors/` — sensor sweep over a diff. Maps to project_globs from harness-core.
- `reviewer/` — reviewer subagent (Layer C). Same model as implementer, fresh context.
- `uat/` — UAT pipeline (Layer U). Probes, runner, persistent UAT.md, evidence-file gate.
- `backprop/` — backprop subagent dispatcher. Uses harness-core's ground/invariants writer to persist §V entries.
- `watchdog/` — stall detector + remediation post.
- Slash command handlers (`/halt`, `/status`, `/queue`, `/eval`, `/resume`, `/oops`, `/archive`, `/unpause`, `/help`).

### 3.3 `harness-frontend-discord` — Discord adapter

What lives here:
- `adapter.ts` — `DiscordFrontendAdapter` implementing `FrontendAdapter` from core.
- `channels/` — channel-per-task lifecycle.
- `slash/` — slash command builder + registration.
- `acl/` — owner-id ACL.
- `embed/` — embed builder, taskBody render, recent-events feed.

### 3.4 `harness-frontend-stub` — test adapter

In-memory adapter for smokes. Records every postTaskUpdate / requestApproval / requestDialog / notify call. Programmable response for dialogs.

### 3.5 `harness/` — umbrella + CLI bin

Stays as the top-level package adopters install via `pnpm dlx --package harness harness <subcommand>` (or eventual `npx @devplusllc/harness`).
- `bin/` — CLI entry: `harness init / watch / run / task / install`.
- `src/cli/` — command implementations. Each composes core + runtime + frontends.
- `scripts/` — smokes (per-package smokes get extracted to their own packages later; for now keep here for cross-cutting integration tests).
- Re-exports for any adopter that wants to do `import { ... } from "harness"` without thinking about sub-packages.

## 4. The FrontendAdapter contract

The boundary between runtime and frontend is the `FrontendAdapter` interface (currently in `harness/src/frontend/types.ts`; moves to `harness-core/src/types.ts`):

```ts
interface FrontendAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onTask(handler): void;
  onVoice(handler): void;
  onSlash(handler): void;
  onFreeText(handler): void;
  onInteraction(handler): void;
  postTaskUpdate(update: PostUpdate): Promise<void>;
  requestApproval(bundle: ApprovalBundle): Promise<Approval>;
  requestDialog(spec: DialogSpec): Promise<DialogResponse>;
  notify(level, message): Promise<void>;
  startTyping?(channelId): () => void;
  isChannelAlive?(channelId): Promise<boolean>;
}
```

Runtime calls `adapter.requestDialog(spec)` and gets a Promise<DialogResponse>. It does not know whether that's a Discord button click, a CLI prompt, a Notion page comment, or a stub. Frontends are interchangeable.

## 5. The MCP surface — Harness's public API

The harness MCP server (in harness-core) is what agents talk to during a run. From the agent's perspective, **the MCP is what Harness IS**. Tools include:

- `harness_decision_get(id)` — full ADR + assertions
- `harness_decisions_in_scope(globs[])` — IDs whose scope overlaps the run
- `harness_invariant_get(id)` — §V invariant + linked sensor
- `harness_canonical_for_topic(topic)` — canonical doc path + verified-at
- `harness_query_history(scope, question)` — the only path into `.archive/`
- `harness_record_decision(...)` — drop a decision draft to `_inbox/`
- `harness_query_history(scope)` — the only path into `.archive/`
- … (15 total — see `MCP_SURFACE.md`)

Adopters who want only the state layer install `harness-core` and register the MCP server. They don't need runtime or any frontend adapter.

## 6. Open boundary question — `voice/`

`voice/` (Whisper transcription) currently lives in `harness-core` on the argument that runtime can't depend on a frontend. The cleaner model: voice input is a frontend adapter concern — the adapter receives audio, transcribes it, and emits a `FreeTextEvent` to the runtime. The transcription pipeline moves to the Discord adapter (and any future voice-capable adapter). `harness-core` stops owning Whisper.

This is deferred but flagged: the current placement is a forced compromise, not a design choice.
