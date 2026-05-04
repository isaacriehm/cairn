---
type: architecture
status: draft-v1
audience: dual
generated: 2026-05-04
supersedes-framing: docs/PRIMER.md §3, docs/INTEGRATION_PLAN.md §1
purpose: Lock the new mental model — Cairn is a state + context-loading layer, not a bundled agent orchestrator. Splits today's single `harness/` package into four workspace packages with clean boundaries.
---

# Cairn — Architecture (layered model)

This doc supersedes the earlier framing that treated Cairn as one monolithic "agent orchestrator with Discord UX bolted on". The actual product is **state management + context loading for AI orchestration**. Orchestration runtime, sensor sweeps, mirror checkouts, UAT pipelines, and Discord adapters are *consumers* of the Cairn state layer — not part of its core.

## 1. Three layers, four packages

```
┌────────────────────────────────────────────────────────────────────┐
│  FRONTEND (UX adapter)                                             │
│    packages/harness-frontend-discord  — Discord bot + voice +      │
│                                          channels + slash + buttons │
│    packages/harness-frontend-stub     — In-memory test adapter     │
│    (future: harness-frontend-cli, harness-frontend-notion, …)      │
└────────────────────────────────────────┬───────────────────────────┘
                                         │ FrontendAdapter contract
                                         │ (DialogSpec, PostUpdate,
                                         │  ApprovalBundle, …)
                                         │
┌────────────────────────────────────────▼───────────────────────────┐
│  RUNTIME (orchestration consumer)                                  │
│    packages/harness-runtime — orchestrator, FIFO queue, mirror     │
│                               checkout, claude subprocess          │
│                               dispatcher, sensor sweep, reviewer,  │
│                               UAT pipeline, watchdog, /halt etc.   │
│                               Knows nothing about Discord.         │
└────────────────────────────────────────┬───────────────────────────┘
                                         │ depends on harness-core
                                         │
┌────────────────────────────────────────▼───────────────────────────┐
│  CORE (state + context)                                            │
│    packages/harness-core   — `.harness/ground/` writers, MCP       │
│                              server (read/write primitives over    │
│                              ground), init mapper, GC drift sweep, │
│                              decision-capture extractor, stub      │
│                              catalog, decision-assertion           │
│                              evaluator, provenance frontmatter,    │
│                              two-zone separation enforcement,      │
│                              spec tightener (context-load gate),   │
│                              claude wrapper + tier0 classifier     │
│                              (shared infra used by tightener +     │
│                              mapper).                              │
│                              The Cairn.                          │
└────────────────────────────────────────────────────────────────────┘
```

**Each layer can be installed independently.** A team that just wants typed access to a curated state ledger installs `harness-core` and writes their own dispatcher. A team that wants the full claude-code orchestration loop installs `core + runtime`. The Discord UX is opt-in via `harness-frontend-discord`.

## 2. Why this split

The old framing produced a 2000-line orchestrator that imported Discord, claude subprocess management, mirror state, UAT, sensors, reviewer, decision-capture, GC. Every adopter pulled the whole stack whether they wanted it or not. It made the operator feel like Cairn was "the bot that does everything" — when the actual load-bearing thing is **the curated state layer underneath**.

Concrete wins of the split:

1. **Clearer purpose.** "Cairn is the state + context-loading layer" is a sentence anyone can hold. "Cairn is a Symphony-shaped agent orchestrator with voice + Discord + sensors + UAT" is not.
2. **Adopters can pick what they want.** Use harness-core in a CLI workflow; use core+runtime with a custom CI driver; use the full stack with Discord. Each combination installs cleanly.
3. **Frontend pluggability becomes real, not aspirational.** Adding a Notion adapter doesn't require touching the orchestrator; it implements the FrontendAdapter contract from harness-core.
4. **Each package has its own smoke + typecheck + version cadence.** A change to the discord adapter doesn't force a re-typecheck of the GC.
5. **The MCP surface is the public API.** harness-core's MCP server is what AI agents talk to; the rest of the harness is plumbing around that surface. Splitting makes this contract explicit.

## 3. Package contents

### 3.1 `harness-core` — the state + context layer

What lives here:
- `init/` — wizard, mapper (Tier-2 LLM walker), walker (gitignore-aware repo summarizer), workflow-block (round-trip the `<slug>:` extension block), seed (templates), prompts (inquirer), secrets (env file management), setup-runners (whisper/ollama/etc downloads)
- `ground/` writers — append-only writes to `.harness/ground/{decisions,invariants,canonical-map,quality-grades}`. Mechanical; never LLM-writes here.
- `mcp/` — the harness MCP server. 18+ typed tools: `decision_get`, `invariant_get`, `decisions_in_scope`, `canonical_for_topic`, `query_history`, `ask_operator`, etc.
- `gc/` — garbage collection drift sweep. Frontmatter freshness, generator drift, dependency direction violations, doc-gardening. Auto-merge safe-class.
- `decision-capture/` — Tier-1 extractor + refinement-proposer. Operator's `/direction` text → candidate ADR → confirmed → ground/decisions/.
- `claude/` — subprocess wrapper for `claude --print --output-format json|stream-json`. Used by tightener, mapper, decision extractor.
- `tier0/` — Ollama classifier (intent + activity-summary). `tier_assignment.intent_classifier=0` per workflow.md.
- `tightener/` — spec quality gate. Tier-1 LLM call that scores incoming task body, surfaces ambiguities + acceptance gaps, proposes tightened spec. The "do we have enough context to start?" gate.
- `stub-pattern/` (catalog evaluator) — runs the `.harness/config/stub-patterns.yaml` patterns over a diff. Layer A.
- `decision-assertion/` (evaluator) — evaluates the machine-readable assertions on each accepted decision against a diff.
- `provenance/` — frontmatter validation + verification helpers.
- `types.ts` — shared types: `RunPhase`, `DialogSpec`, `PostUpdate`, `ProjectGlobs`, `MapperOutput`, etc.
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
- `adapter.ts` — the `DiscordFrontendAdapter` class implementing FrontendAdapter from core.
- `channels/` — channel-per-task lifecycle (📋 backlog / 🟢 active / 📦 archive).
- `slash/` — slash command builder + registration.
- `acl/` — owner-id ACL.
- `voice/` — Whisper transcription pipeline (whisper.cpp via smart-whisper). Lives here because it's only used by Discord today; if a future adapter wants voice, factor a sub-package.
- `embed/` — phase color/emoji map, embed builder, taskBody render, recent-events feed.

### 3.4 `harness-frontend-stub` — test adapter

In-memory adapter for smokes. Records every postTaskUpdate / requestApproval / requestDialog / notify call. Programmable response for dialogs.

### 3.5 `harness/` — umbrella + CLI bin

Stays as the top-level package adopters install via `pnpm dlx --package harness harness <subcommand>` (or eventual `npx @isaacriehm/harness`).
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

## 5. The MCP surface — Cairn's public API

The harness MCP server (in harness-core) is what agents talk to during a run. From the agent's perspective, **the MCP is what Cairn IS**. Tools include:

- `harness_decision_get(id)` — full ADR + assertions
- `harness_decisions_in_scope(globs[])` — IDs whose scope overlaps the run
- `harness_invariant_get(id)` — §V invariant + linked sensor
- `harness_canonical_for_topic(topic)` — canonical doc path + verified-at
- `harness_query_history(scope, question)` — the only path into `.archive/`
- `harness_ask_operator(question, options[])` — pause + ask mid-run
- … (18 total today)

Adopters who want only the state layer install `harness-core` and register the MCP server with their own claude-code or codex setup. They don't need the runtime or the Discord bot.

## 6. Migration path (single → multi-package)

The current `harness/` package contains everything. The migration is mechanical:

1. **Skeleton packages** — create `packages/{harness-core, harness-runtime, harness-frontend-discord, harness-frontend-stub}/{package.json, tsconfig.json, src/index.ts}`.
2. **Update workspace** — `pnpm-workspace.yaml` adds `packages/*`.
3. **Move directories** — git mv the contents per the §3 layout above.
4. **Rewrite imports** — `from "../foo/bar.js"` → `from "@isaacriehm/harness-core"` etc.
5. **Update top-level `harness/` package.json** — depend on the four sub-packages.
6. **Re-typecheck + re-smoke** — fix the inevitable circular-import gotchas.
7. **Bump versions** — each sub-package gets its own semver. Initial release is 0.0.0 across the board.

The git-mv approach preserves blame across the move. Don't rewrite history.

## 7. Open questions for next session

1. **Where does `inbox.ts` live?** It's used by both frontends (writes) and runtime (reads). Probably harness-core (it's a state-layer concern) — or its own tiny `harness-inbox` package.
2. **Where does `voice/` live?** Currently only Discord uses Whisper, but it's pure-deterministic transformation. Leave in `harness-frontend-discord` for now; extract if a second adapter wants it.
3. **Smoke split.** Per-package smokes are cleaner but add ceremony. For phase 1 keep all smokes in `harness/scripts/`.
4. **Versioning.** Each sub-package independent semver, OR lockstep at 0.0.0 until the first ship?
5. **`@isaacriehm/` scope.** Today the package.json reads `@isaacriehm/harness` for the umbrella. Sub-packages should follow: `@isaacriehm/harness-core`, `@isaacriehm/harness-runtime`, etc.
6. **CLI bin location.** Stay in `harness/` umbrella, OR extract to `harness-cli`?

These are decisions to lock before running the migration commands.
