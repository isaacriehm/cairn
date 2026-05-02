---
type: primer
status: draft-v2
audience: dual
generated: 2026-05-02
sources:
  - https://openai.com/index/harness-engineering/ (cited via MartinFowler / InfoQ / Latent Space)
  - https://openai.com/index/open-source-codex-orchestration-symphony/
  - https://github.com/openai/symphony (SPEC.md, README.md)
  - https://martinfowler.com/articles/harness-engineering.html (Birgitta Böckeler, 2026-04-02)
  - https://github.com/JuliusBrussee/cavekit (v4 — single-file SPEC pattern, backprop)
  - thedotmack/get-shit-done (locally installed; canonical-refs, hypotheses, blocked_by tagging)
  - thedotmack/claude-mem (token-cost anti-pattern study)
  - docs/orchestration/_research/STALENESS_INVENTORY.md
  - docs/orchestration/_research/DISCORD_WHISPER_DESIGN.md
---

# Harness Engineering & Agent Orchestration — Primer for mypal.

A teaching document. Read this end-to-end. The other six docs in `docs/orchestration/` (`INTEGRATION_PLAN.md`, `FILESYSTEM_LAYOUT.md`, `MCP_SURFACE.md`, `UAT_PIPELINE.md`, `WORKFLOW_GUIDE.md`, `QUESTIONS.md`) are reference material that depends on the concepts here.

## TL;DR

You have been hitting the same failure pattern: an agent runs, produces confident output, the output looks structured, you commit it, and weeks later you discover the agent fabricated facts, copied stale conventions, claimed completion on stubs, or invented file paths that don't exist. mypal's `core/REVIEW_DECISIONS.md` is a long record of multiple agents passing over the same dishonesty. This is **not** a model problem. It is a **harness** problem.

> *"An AI agent is not just a model — it is a model plus the control system that governs it."* — paraphrase of OpenAI's framing, Feb 2026

OpenAI shipped two things in spring 2026 that codify the fix:

1. **Harness engineering** — the discipline of designing the controls around a model: guides that direct it, sensors that verify it, a data pipeline that grounds it. *Agent = Model + Harness.*
2. **Symphony** — a reference orchestrator (Apache 2.0) that turns issues into isolated, autonomous coding-agent runs. Spec is language-agnostic; v1.1.0 added Kata-CLI support so it can drive Claude Code, Gemini, and others.

Both target the same problem: stop supervising agents turn-by-turn, start managing the **work**. Your existing setup (Claude Code + AGENTS.md + `.claude/rules/*`) already does most of what a harness needs. The gaps:

- A grounding layer that doesn't rot
- A per-task workspace + prompt contract  
- Sensors that fail loud when the agent invents facts
- A front-end that lets you queue work without sitting at the terminal
- A way to catch fake-completion before it lands
- A way to capture user-issued direction changes as binding facts that survive

This primer is the conceptual base. `INTEGRATION_PLAN.md` applies it to mypal.

---

## 1. What harness engineering actually is

Birgitta Böckeler (Thoughtworks Distinguished Engineer, *Harness Engineering for Coding Agent Users*, 2026-04-02) decomposes the harness into two mechanisms:

| Mechanism | Role | Examples |
|-----------|------|----------|
| **Guides** (feedforward) | Anticipate behavior and steer before action occurs | System prompts, AGENTS.md, constraint docs, schema files, type definitions, scoped rules, decision ledgers |
| **Sensors** (feedback) | Observe after the agent acts; enable self-correction | Linters, type checkers, evals, AI code review, drift detectors, output parsers, attestation cross-checks |

Each can be **computational** (deterministic, fast — `tsc`, `eslint`, structural tests, file-hash diffs) or **inferential** (semantic — AI code review, semantic diff, drift detection). Computational sensors are cheap; saturate them. Inferential sensors are slow; use them at high-stakes gates only.

Three regulation domains:

| Domain | Regulates | mypal example |
|--------|-----------|---------------|
| Maintainability | Internal code quality | TypeScript law, ESLint, file-structure conventions, DTO rules |
| Architecture fitness | Cross-module shape | Layered-dependency rules, "no business logic in controllers", `pnpm openapi:generate` after DTO changes |
| Behaviour | Functional correctness | E2E with real DB, evals against golden cases |

OpenAI's stated description of their internal harness:

> *"Layered architecture enforced by custom linters and structural tests, and recurring 'garbage collection' that scans for drift and has agents suggest fixes. Our most difficult challenges now center on designing environments, feedback loops, and control systems."*

Two principles to internalize:

- **Harnessability is a property of the codebase.** Strongly-typed languages, definable module boundaries, conventional frameworks support more controls. mypal is well-positioned (TypeScript + NestJS + Drizzle).
- **Ashby's Law of Requisite Variety.** A regulator needs as much variety as the system it governs. Your "shit output" experience = the agent's possibility space exceeds your harness's capacity. Either narrow the system (commit to topologies) or widen the harness (more sensors, more guides).

What this is **not**:

- Not prompt engineering. Prompt engineering tunes one inference. Harness engineering tunes the system around many inferences over time.
- Not a framework. It's a discipline expressed through whatever primitives the tooling exposes.
- Not "more AI." Half the harness is deterministic. Inferential controls are the minority.

---

## 2. The vibe-coded failure mode (named)

Naming the pattern makes it diagnosable:

1. Agent receives a task with limited context.
2. Agent does not know your conventions, prior decisions, or current file state. It infers.
3. Agent produces structured output (bullets, decision IDs, tables). Structure makes it look correct.
4. You commit the output to a markdown file.
5. The output becomes "history." The next agent reads it as canon.
6. Errors compound across runs.

The failure is **not** the model hallucinating. The failure is the **harness** treating an unverified agent emission as canonical context. There is no sensor between step 3 and step 4. There is no provenance tag distinguishing "draft proposal" from "verified canon."

Symptoms in your repo (from `_research/STALENESS_INVENTORY.md`):

- `STATE.md` lists deleted programs as "in flight"
- `docs/remediation/README.md` claims subdirectories that were hard-deleted on 2026-04-24
- `docs/design/mobile-flows.md` describes a Swift app deleted in commit `a3e26be`
- Five different "RESUME-*" handoff variants
- `docs/engineering/api-map.md` (1,823 lines) hand-mirrors `core/openapi.json`; both stamped `last-verified: 2026-04-23`; drift inevitable

These are not bad files. They are files written without sensors.

Two patterns fix this:

| Pattern | Mechanism | mypal application |
|---------|-----------|-------------------|
| **Generated > written** | Where a deterministic generator can produce a doc, do that. The generator is itself a sensor — it fails when source diverges. | Replace `api-map.md` with generated index from `openapi.json`. Replace `data-model.md` with schema dump. |
| **Provenance tagged** | Every artifact carries who/when/source/hash. Stale artifacts are detectable, not merely suspicious. | YAML frontmatter required: `status`, `audience`, `generated`, `verified-at`, `source-commits`. CI fails if frontmatter older than threshold. |

---

## 3. Symphony — what it is, what it isn't

Read the SPEC at `https://github.com/openai/symphony/blob/main/SPEC.md`. Distillation:

### 3.1 Tagline (verbatim)

> *"Symphony turns project work into isolated, autonomous implementation runs, allowing teams to manage work instead of supervising coding agents."*

### 3.2 Six abstraction layers (verbatim)

| # | Layer | Role |
|---|-------|------|
| 1 | Policy | `WORKFLOW.md` prompt body + team-specific rules |
| 2 | Configuration | Typed getters from front-matter into runtime settings |
| 3 | Coordination | Polling loop, eligibility, concurrency, retries, reconciliation |
| 4 | Execution | Filesystem lifecycle, workspace prep, coding-agent protocol |
| 5 | Integration | Tracker adapter (Linear today; pluggable) |
| 6 | Observability | Logs + optional status surface |

### 3.3 Eight components (verbatim)

`Workflow Loader`, `Config Layer`, `Issue Tracker Client`, `Orchestrator`, `Workspace Manager`, `Agent Runner`, `Status Surface` (optional), `Logging`. **The orchestrator is the only component that mutates scheduling state.** Everything else reports back.

### 3.4 The single load-bearing artifact: `WORKFLOW.md`

Repo-owned: YAML front-matter (config) + Markdown body (per-task prompt template). Hot-reloads. Bad reload? Service keeps last-known-good. (Symphony §6.2.)

### 3.5 Run lifecycle (verbatim §7.2)

`PreparingWorkspace → BuildingPrompt → LaunchingAgentProcess → InitializingSession → StreamingTurn → Finishing → (Succeeded | Failed | TimedOut | Stalled | CanceledByReconciliation)`

### 3.6 Workspace isolation

Each issue gets a deterministic-named workspace under `workspace.root`. Same identifier → same path across runs. Agent commands run only inside this directory.

### 3.7 What's novel

- **Repo-owned policy** (most agent frameworks treat the prompt as service config)
- **Hot reload with last-known-good fallback**
- **No durable orchestrator DB.** State is rebuilt at startup from tracker + filesystem.
- **Pass-through Codex config** (sandbox / approval forwarded to whatever app-server is installed)

### 3.8 Reported outcomes

- "Some teams at OpenAI saw a 500% increase in landed pull requests during the first three weeks of using Symphony" (Help Net Security)
- 5-month no-manually-written-code experiment: ~1M LOC, ~1,500 PRs, started 3 engineers (ended 7), $2-3K/day token spend, single agent runs "upwards of six hours" (Lopopolo, Latent Space)

---

## 4. Grounding-context layer — single source of truth

The most important harness component is the layer that tells every agent what is true about the codebase right now. The vibe-coded failure mode happens when this layer is missing, fragmented, or stale.

### 4.1 What it must answer

| Question | Failure if unanswered |
|----------|----------------------|
| What is the product? | Agent invents positioning |
| What is the stack? | Agent picks libraries you don't use |
| What are the conventions? | Agent writes against ESLint defaults instead of your law |
| What entities exist (schema, DTOs, routes)? | Agent invents fields and paths |
| What was decided previously? | Agent re-debates settled questions or contradicts past decisions |
| What was deleted/superseded? | Agent treats stale docs as canon |
| Who is the operator? | Agent over-explains or under-explains |

### 4.2 Layout for mypal (filesystem-only)

```
<repo>/
├── AGENTS.md                  ← orientation + coding law (TOC pattern; ~150 lines max)
├── CLAUDE.md                  ← @AGENTS.md alias for Claude Code
├── .claude/
│   ├── rules/*.md             ← path-scoped law (auto-loaded by Claude Code)
│   ├── agents/*/AGENT.md      ← subagent definitions
│   └── skills/*/SKILL.md      ← skill packs
├── docs/                      ← canonical authored docs (provenance frontmatter REQUIRED)
│   ├── product/               ← positioning, personas, pricing
│   ├── engineering/           ← architecture (most generated)
│   ├── domain/                ← business rules
│   ├── decisions/             ← ADRs (immutable once accepted)
│   ├── design/brand/          ← brand guidelines (canonical)
│   └── orchestration/         ← THIS DIRECTORY
└── .harness/                  ← harness state + policy + ground (mostly committed)
    ├── config/                ← workflow.md, sensors.yaml, stub-patterns.yaml — COMMITTED
    ├── ground/                ← THE source of truth — COMMITTED
    │   ├── decisions/         ← one ADR file per binding decision
    │   ├── invariants/        ← §V invariants from backprop protocol
    │   ├── canonical-map/     ← topic → canonical-doc-path mapping
    │   ├── schema/            ← drizzle dump (mechanically regenerated)
    │   ├── routes/            ← openapi → endpoint table
    │   ├── events/            ← emitter+listener registry
    │   ├── manifest.yaml      ← {path, sha256, verified_at, classification} per file
    │   ├── quality-grades.yaml ← per-module score from GC pass
    │   └── glossary.md
    ├── tasks/{active,done,archived}/   ← per-task spec + status — COMMITTED
    ├── runs/{active,terminal}/         ← per-run artifacts                — GITIGNORED
    ├── inbox/                          ← raw Discord ingress               — GITIGNORED
    ├── transcripts/                    ← Whisper outputs                   — GITIGNORED
    └── staleness/                      ← drift detector live state         — GITIGNORED
└── .archive/<date>/...                ← quarantined historical             — COMMITTED, hook-gated
```

### 4.3 Three rules that govern this layout

1. **Generated > hand-written wherever a generator exists.** Hand-written docs rot. Generated docs fail loud when source diverges.
2. **Frontmatter required** on every load-bearing markdown: `type, status, audience, generated, verified-at, source-commits, supersedes`. CI rejects load-bearing docs missing these.
3. **Tier the audience** (`ai-only`, `dual`, `human-only`) per `.claude/rules/output-format.md`. Mixing tiers in one file is the most common cause of doc rot.

### 4.4 Two-zone canonical-vs-historical separation (NEW; load-bearing)

Stale never sits next to live. Two zones, hook-enforced:

| Zone | Location | Default agent discoverability |
|------|----------|-------------------------------|
| **canonical** | `docs/`, `.harness/ground/`, `.harness/tasks/active/`, `.harness/runs/active/` | grep/glob/find hits this by default |
| **historical** | `.archive/<date>/...`, `.harness/runs/terminal/`, `.harness/tasks/{done,archived}/` | excluded from default tool calls; only via explicit `harness_query_history` MCP |

Enforcement = PreToolUse hook on Read/Glob/Grep filters out historical paths. Default behavior is "canonical only." Override = explicit historical query.

This kills the "two truths in the context window" pattern. Agent never *sees* stale unless it explicitly asks.

### 4.5 The relevance window

Critical: agent context is not infinite, and the relevance window is shorter than the docs you'd hand a new hire. **The longer your AGENTS.md, the worse your harness performs.** OpenAI tried "one big AGENTS.md" and explicitly named the failure modes:

1. Context crowding — large file displaces task / code / docs
2. Non-guidance from over-guidance — agents pattern-match locally when everything is marked important  
3. Instant rot — cannot be mechanically verified
4. Undetectable drift — single documents decay silently

OpenAI's reported solution (Lopopolo, multiple sources): *"treat AGENTS.md as the table of contents"*, ~100 lines, mapping to deeper progressive-disclosure docs. mypal's current AGENTS.md is 128 lines and already TOC-shaped — keep it that way; document the rule for the generic harness package.

---

## 5. Agent roles + the orchestrator pattern

Symphony's hard boundary: orchestrator schedules and owns state; agents do work.

### 5.1 Orchestrator responsibilities

- Decide what runs
- Allocate isolated mirror checkout
- Render per-task prompt from policy template
- Launch the agent
- Watch for stalls / failures / state changes
- Reconcile against the tracker / filesystem
- Surface progress to the operator
- Commit and push agent output to main (no PRs, no branches; see §7)

### 5.2 Agent responsibilities

- Read the rendered prompt + the workspace
- Use tools to make changes
- Emit attestation (see §10)
- Exit cleanly

### 5.3 What this rules out

- Agents calling each other directly (they go through the orchestrator)
- Agents updating the policy (policy is repo-owned; humans commit)
- The orchestrator running business logic (it's a scheduler)

### 5.4 Single-task pipeline (mypal default)

You operate sequentially: 1 task started, 1 task finished, then next. Concurrency cap = 1. New task arrives during a run → queued FIFO with Discord status shown. `/halt` to interrupt.

Within a single run, parallelism is everywhere it doesn't conflict:

| Class | Inside one run |
|-------|---------------|
| **Sensor parallelism** | All independent sensors run in parallel (mechanical, no token cost) |
| **Subagent fan-out** | After fixer commits, reviewer + UAT-runner + backprop-author run in parallel |
| **Read-only research** | Mappers and queriers uncapped |
| **Background GC** | Runs nightly cron, against committed state only — never overlaps in-flight task |

### 5.5 No branches, no PRs

You are solo. Branches and PRs are workflow overhead with zero benefit at this scale. The harness operates against a **parallel mirror checkout** at `~/.local/harness/repos/<project>/` — its own clone, distinct from your working tree. It pulls/pushes to/from origin like a developer. Your local checkout is sacred — harness never touches it.

Run flow:

1. Task lands → spec tightener runs
2. Mirror: `git fetch origin && git reset --hard origin/main` — pin to SHA `abc123`
3. Agent works in mirror, change uncommitted
4. Sensors run against the diff
5. Reviewer subagent runs (fresh context — sees only diff + spec, NOT implementer's reasoning)
6. UAT runs (if applicable; see §9 + UAT_PIPELINE.md)
7. 🟢 → `git commit && git push origin main` (auto for safe-class; user-confirmed for code-class)
8. Backprop runs → second commit `chore(invariants): add §V<N> from run #<id>`
9. Run closes

User pulls when convenient. Standard git world; conflicts handled on user's side.

---

## 6. Eval harness — sensor classes, not "tests"

> *"Tests are shitware, the only tests that matter truly is E2E with real db."* — your stance, confirmed multiple times.

Confirmed. Drop the test framing entirely. Sensors and E2E real-DB only. Five classes:

| Class | Cost | Latency | Use for |
|-------|------|---------|---------|
| Lint / type-check | ~0 | seconds | Constant; on every save / commit / PR |
| Structural test | Low | seconds | Architecture rules (layers, no cross-module imports, dependency direction) |
| Generator drift | Low | seconds | "Is the generated artifact still in sync with source?" — `pnpm openapi:generate` no-diff check, schema dump diff |
| E2E with real infra | High | minutes | Behaviour gates on critical flows (auth, recording-persistence, deal stage) |
| Inferential review | Highest | minutes | Pre-merge AI code review on high-stakes diffs (Layer C; same model, fresh context) |

mypal's golden-case sensor list (proposed at init, refined per `WORKFLOW_GUIDE.md` tier ladder):

| Sensor | Surface | Pass criterion |
|--------|---------|----------------|
| `openapi-no-drift` | DTO ↔ generated types | `pnpm openapi:generate` produces no diff |
| `schema-drift` | Drizzle schema ↔ migrations | `pnpm db:generate` produces no diff |
| `event-labels-coverage` | `eventEmitter.emit(...)` ↔ `EVENT_LABELS` | Every emit key has a label |
| `stub-allowlist-purity` | `SHARED_CORE_ACTION_KINDS` | No top-level kind without a real handler |
| `pii-redaction-coverage` | `PiiRuleEngine` | All four financial classes redacted on canonical fixtures |
| `frontmatter-freshness` | Every load-bearing doc | `verified-at` within 30 days |
| `decision-assertions` | Every accepted decision in scope of diff | All `assertions` in `decisions/<id>.md` evaluate true |
| `route-handler-non-empty` | Every NestJS controller method | Body has non-trivial implementation |
| `dto-no-fake-fields` | All `*.dto.ts` | No `@IsOptional()` + always-undefined pattern |

These are computational. They are the harness's spine.

---

## 7. Operator front-end — Discord with channel-per-task

Three high-level surfaces:

| Surface | Pros | Cons |
|---------|------|------|
| CLI | Closest to Claude Code today; no extra infra | Tied to your laptop; bad for queue / mobile |
| Web UI | Persistent, multi-device | You'd build it; auth complexity |
| **Discord** | Free, mobile + desktop, voice + attachments + buttons | Third-party — outage = no operator surface |

Locked: Discord primary, CLI fallback always available. Skip web UI until there's a second user.

### 7.1 Channel topology

| Category | Purpose | Channel lifecycle |
|----------|---------|-------------------|
| `📋 backlog` | Tasks proposed but not running | Channel created when task lands; spec tightening dialog happens here |
| `🟢 active` | Currently-running runs | Channel moves here on dispatch; agent threads progress; UAT happens here |
| `📦 archive` | Completed (succeeded / failed / halted) | Channel moves here on close; locked for writes; readable for history |

Channel-per-task makes lifecycle visible at a glance. No mixing. No "which run was that?" confusion.

### 7.2 Trust posture per command

| Command | Posture | Confirmation |
|---------|---------|--------------|
| `/status` | Read-only | None |
| `/task` | Creates a backlog channel | None |
| `/oops`, `/direction` | Conversational; multi-step dialog | Inline reactions |
| `/run` | Spawns an agent run | Reaction-confirm if outside pilot scope |
| `/halt` | Kills active run | None |
| `/ship-anyway` | Override spec-tightener / autonomy gate | None |

Pattern: read-only without friction; write-creating with light friction; configuration-changing with hard friction. Every confirmation has a 30-second timeout (auto-deny).

### 7.3 Squares-into-square-holes UX (load-bearing)

The harness ALWAYS proposes A/B/C/D before asking for typed input. Operator picks; harness does the structuring. Free-text is escape hatch (`E) Other / describe`). See `WORKFLOW_GUIDE.md` for full dialogue templates.

---

## 8. Voice-as-input + local Whisper

Voice notes from Discord auto-pickup. See `_research/DISCORD_WHISPER_DESIGN.md` for full design.

### 8.1 Pipeline

```
Discord audio attachment → buffer fetch → ffmpeg → whisper.cpp streamed → transcript
                                                                              ↓
                                                         intent classifier (Tier 0 Ollama → Tier 1 fallback)
                                                                              ↓
                                                                   harness intake → agent run
```

Audio is **never written to disk**. Buffer → pipe → pipe → text. Transcript persists; audio doesn't.

### 8.2 Choices

| Component | Pick | Rationale |
|-----------|------|-----------|
| Backend | `whisper.cpp` via Homebrew | Metal+CoreML on M-series; ~10× realtime; TS-native via `smart-whisper` npm |
| Model | `large-v3-turbo` Q5 | ~95% accuracy; ~800 MB; ~3s for 30s clip |
| Diarization | None | Single-speaker founder use case |

### 8.3 Confidence guard

`avg_logprob < 0.85` → bot replies "Heard: '...' — confirm?" with 🟢/🔴. Above threshold → silent route to intent classifier. See `WORKFLOW_GUIDE.md`.

---

## 9. UAT-on-phone — the click-button-confirm pattern

The "AIs want UAT but I can't access the site from my phone" problem.

### 9.1 Pipeline

```
[implementer commits in mirror]
    ↓
[sensors run]
    ↓
[reviewer subagent (same model, fresh context)]
    ↓
[UAT-runner agent generates Playwright script + runs headless]
    ├─ captures: GIF (gif_creator MCP), N screenshots, console log, network log
    └─ for backend-only: curl/SQL transcript
    ↓
[Discord post in run-channel]
    "🎬 UAT for run #142
     Goal: <tightened spec one-liner>
     [embedded GIF — autoplays in Discord]
     Pass criteria checked: ✓ A  ✓ B  ✗ C
     [🟢 approve & push]  [🔴 reject + tell me why]  [❓ ask follow-up]"
    ↓
[user on phone, anywhere]
    🟢 → harness pushes to main + runs backprop
    🔴 → harness asks A/B/C/D for reason → re-spawn implementer with rejection context
    ❓ → harness opens thread, you ask, agent answers from run artifacts
```

### 9.2 Evidence-file gate

Inspired by community patterns around OpenAI's harness. UAT outputs a `.uat-passed` file containing SHA256 of the actual UAT artifact (GIF/screenshots/curl-transcript). A bare `touch` is rejected. This blocks the harness's own commit step until evidence is real. See `UAT_PIPELINE.md`.

### 9.3 Persistent UAT.md per task (from GSD)

`.harness/tasks/<id>/uat.md` carries `status: in-progress | passed | failed | blocked` and per-step state. Survives context resets. Resumable. Tagged `blocked_by` (server / external service / device) is **never** folded into Gaps — environmental blockers ≠ code bugs.

---

## 10. Honest agent invariants (NEW — load-bearing)

The dishonesty problem (mypal's 28-stub history). Six layers, stacked. Each removes a class of fakery.

### Layer F — Pre-execution spec tightener (Tier 1 LLM)

Before any code is written. Triggered on `intent: run | fix_issue | review_module`. Inputs: task title + body, decisions ledger, ground extracts in scope, existing stubs/TODOs in scope (mechanical scan). Output: structured JSON with ambiguities, conflicts, missing acceptance criteria, scope concerns, existing stub overlap, spec_quality_score, ready_to_execute, and a `tightened_spec_proposal`. Operator answers any surfaced questions or `/ship-anyway`. Cost: one LLM call. **No phase-gating, no ceremony — single interrogation.**

### Layer A — Mechanical stub catalog

`.harness/config/stub-patterns.yaml`. Init seeds with ~30 patterns. Grows additively via `/oops` dialog (never CLI). Patterns: `throw new Error('not implemented')`, empty function bodies, `as any`, commented-out blocks, `@IsOptional()` + always-undefined, etc. Runs on every diff. ~5s, zero tokens.

### Layer B — Self-attestation contract

Every run completion produces `attestation.yaml`:

```yaml
delivered:
  - symbol: "ContactsService.merge"
    behavior: full   # full | partial | scaffolded
    sensors_passed: [...]
deferred:
  - symbol: "..."
    reason: "..."
known_limitations: [...]
todos_introduced: 0
stubs_introduced: 0
files_touched: [...]
```

Cross-checked mechanically against the diff:

| Claim | Mechanical check | Fail mode |
|-------|------------------|-----------|
| `behavior: full` for symbol X | scan symbol body for stub patterns | "lied about completeness on X" |
| `todos_introduced: 0` | grep diff for new TODO/FIXME | mismatch → reject |
| `stubs_introduced: 0` | mechanical stub detector | mismatch → reject |
| `sensors_passed: [...]` | re-run those sensors | mismatch → reject |
| `files_touched: [...]` | git diff filename list | mismatch → reject |

Lying = harder than telling truth.

### Layer C — Reviewer subagent (same model, fresh context)

Fresh subagent reads ONLY: `task.spec.tightened.md`, the diff, decisions ledger, in-scope assertions. NOT implementer's reasoning. Anti-completionist prompt (default-fail framing). Same model — context isolation is what catches blindspots, not weight diversity. Doesn't burn the plan twice.

**High-stakes augmentation (per Codex audit Q1):** the reviewer prompt for runs touching multi-tenant or scope-sensitive surfaces explicitly checks **query-scope completeness** — every `WHERE` clause, every filter parameter, every authorization predicate must include all the scoping fields the spec demands (e.g., `organizationId AND userId AND active=true`, not just `organizationId`). Reviewer is asked: *"Identify any query, filter, route handler, or service method that omits a scoping field that should be present given the task's scope."*

### Layer D — Project-specific sensors

Listed in §6 above. Project-specific from `WORKFLOW.md` `<project>:` extension block (e.g., `mypal:`, `acme:`). The init script proposes; user accepts/rejects. **Harness package code is project-agnostic — it reads the extension block by `Object.keys()` lookup, never by hardcoded project name.** All "mypal-specific" references in this doc set are illustrative; in the package, `mypal` is just the example adopted-project name.

### Layer E — Demo / E2E (high-stakes only)

For runs touching the project's high-stakes globs (per `<project>:` `high_stakes_globs` config; for mypal: `core/src/{calls, deals, contacts, integrations, telephony}/**`): real E2E suite or recorded demo script. Catches "passed sensors but doesn't work" cases.

**Cross-tenant fixture requirement (per Codex audit Q1):** any high-stakes UAT MUST include at least one negative/cross-tenant fixture — i.e., a request from user/org B against a resource owned by user/org A. The acceptance check passes only if the request returns the expected denial (404 / 403 / scoped-empty-result, per project convention). Without this fixture, an implementation that filters by `provider` only (omitting `user_id`) can pass all other gates while shipping a cross-tenant leak. The cross-tenant fixture is the gate that closes the leak.

### Layer U — UAT-on-phone (every code-class run before push)

§9 above. Evidence-file gate, Discord button confirm. For high-stakes runs, the UAT bundle MUST cite the cross-tenant fixture result; absence fails the evidence-file gate even if other ACs pass.

### Decision-assertions (additional sensor)

Each accepted decision carries machine-readable `assertions`. Sensor evaluates them against the diff. Failure quotes the assertion id + decision id + the contradicting line. See `MCP_SURFACE.md` and `INTEGRATION_PLAN.md`.

### Composition

```
[task spawned]
    ↓
[F: spec tightener] ───→ if quality_score < 7, dialog with operator
    ↓ pass
[mirror reset to origin/main SHA, agent runs]
    ↓
[agent emits attestation.yaml + diff + (optional) demo.sh]
    ↓
[A: mechanical stub scan]
    ↓ pass
[B: cross-check attestation vs evidence]
    ↓ pass
[D: project-specific sensors]
    ↓ pass
[decision-assertions sensor]
    ↓ pass
[C: reviewer subagent (fresh context, same model)]
    ↓ pass
[E: high-stakes only — demo/E2E]
    ↓ pass
[U: UAT-on-phone via Discord button]
    ↓ 🟢
[git commit + push to main]
    ↓
[backprop: §V invariant + sensor pattern + naming convention]
    ↓
[run closes; channel moves to 📦 archive]
```

Any layer fails → run marked `failed-honesty-check` with structured findings + remediation message. Agent retries with the failure context **as new prompt input** (per OpenAI's "lints inject remediation into agent context" pattern). Self-correcting loop without operator in the middle for mechanical fails.

---

## 11. Anti-patterns we deliberately reject

Each named so future contributors (and you) can call out drift:

| Anti-pattern | Source | Why we reject |
|---|---|---|
| **Automatic stale-context injection (read-tool interposition)** | claude-mem (per Codex audit; Claude's earlier framing as "hot-path LLM arbitration" was over-specific to one implementation detail and may have misread claude-mem's actual mechanism — public docs describe automatic tool observation capture + semantic summaries + SessionStart injection + read-tool gating; verbatim "LLM invoked on every tool call to decide whether to remember" is unverified) | Memory writes should not silently inject summarized history into every new session, and read-tools should not be interposed by an opaque memory layer. Pre-filter deterministically. LLM only for transformation, not gating. **Memory writes are free; memory extraction is not.** |
| **Mandatory ceremony before code** | GSD's 8-question init + plan-check loops + security gate | Solo dev with established codebase ≠ greenfield. Default fast; opt-in depth. |
| **One-big-AGENTS.md** | OpenAI tried it, failed (named failure modes above) | Crowds out task/code/docs context, agents pattern-match everything as important, rots silently. AGENTS.md = TOC, ~150 lines max. |
| **Subagent swarms / parallel waves / dashboards** | cavekit v3 → cut in v4 | Coordination cost > benefit at solo-dev scale. We have ONE orchestrator + grounding daemon. |
| **Per-task token budgets / completeness grades / model-tier UI ceremonies** | cavekit v3 → cut in v4 | Overhead without measurable benefit. Tier ladder is enough; no per-task budget UI. |
| **Confidence scores on writes** | mypal AGENTS.md already says this | No model-issued confidence as gate or surface. |
| **Mocked tests piled in to look thorough** | your stated stance | "Tests" in plan = sensors + E2E real-DB only. |
| **Branches and PRs for solo-dev** | your stated stance | Direct commits to main. Mirror checkout isolates the working tree. |
| **CLI commands for every small action** | your stated UX preference | Multiple-choice dialog (squares-into-square-holes) replaces typed args. |
| **Backward-compat shims, deprecation notices, redirects** | mypal AGENTS.md + memory file | Hard cutovers. No transition regex. No "moved to X" stubs. |
| **Stale doc with `[STALE]` banner** | direct corollary of two-zone separation | Stale → moved to `.archive/`. Banner-flagging keeps it next to live; we don't. |
| **Agents writing to ground** | invariant of the design | Ground is mechanically generated by the daemon. Agents read; they don't write. |

---

## 12. Garbage collection cadence (NEW — load-bearing)

OpenAI's *"recurring 'garbage collection' that scans for drift and has agents suggest fixes"* — applied to mypal.

### 12.1 What runs

Nightly cron (`/loop` skill or harness service cron):

| Pass | Scans for | Output |
|------|-----------|--------|
| Frontmatter freshness | Load-bearing docs with `verified-at` > 30 days | Discord summary; auto-PR (Option A) opens self-merging refresh-PR for safe-class refreshes |
| Generator drift | `core/openapi.json` ↔ generated; schema dump ↔ DB; event registry ↔ EVENT_LABELS | Auto-regenerate; commit `chore(gc): regenerate <artifact>` if no source change required |
| Stub catalog hits | New code matching catalog patterns | Open targeted refactor commit; for unsafe-class, surface in Discord for confirm |
| Dependency direction violations | Layered enforcement (Types → Config → Repo → Service → Runtime → UI) | Custom-linter pattern — error message itself is a remediation prompt the next agent run consumes |
| Doc-gardening | docs with broken internal links, dead references, orphan paths | Move to `.archive/` (with operator confirm) or surface for refresh |
| Quality-grade update | per-module score from sensor pass-rate, code-coverage, drift count | Update `.harness/ground/quality-grades.yaml`; surface "weakest module" in `/status` |

### 12.2 Auto-merge classes

| Class | What | Push policy |
|-------|------|-------------|
| **Safe-class** | Formatting, doc regen, frontmatter refresh, generated content, archive moves, stub-catalog additions | Sensors pass → push to main, no UAT, no operator confirm |
| **Code-class** | Touches `*.ts` outside generator-managed files | Sensors + reviewer + UAT → push |
| **High-stakes** | Touches `core/src/{calls, deals, contacts, integrations, telephony}/**` | Above + E2E real-DB pass + Layer E demo |

### 12.3 Why this matters

Wave-1 cleanup is a one-time event. Garbage collection is continuous. Without GC, drift returns. With GC, the canonical surface is **continuously curated**. Stale docs cease to be a category that exists.

---

## 13. Backprop protocol (NEW — load-bearing, from cavekit)

Every fix introduces a permanent invariant. Bug → §V invariant → sensor + test naming convention.

### 13.1 Flow

When a code-class run lands a fix:

1. Backprop subagent runs as second commit phase
2. Reads: spec.tightened.md, the diff, the failure that motivated the fix
3. Outputs: a §V invariant entry to `.harness/ground/invariants/V<N>.md`
4. Generates a sensor (mechanical) or named E2E case to enforce the invariant going forward
5. Naming convention: sensor scripts and E2E cases cite the invariant ID — `check-v42-no-jsonb-userid-filter.ts`, `e2e/V42_actor_user_id_denorm.spec.ts`
6. Commits as `chore(invariants): add §V<N> from run #<id>`

### 13.2 ID rules

- **Monotonic, never reused.** §V42 is §V42 forever, even if invalidated.
- **Invalidation, not deletion.** If an invariant becomes wrong (e.g., a decision supersedes it), mark it `status: superseded_by: V57`. Old sensor disabled but file kept for history.
- **Commits cite invariant IDs** in messages: `fix(integrations): close cross-tenant scope per §V42`.

### 13.3 Why this matters

mypal's `.claude/rules/fix-standard.md` already lists "repeat-failure items" requiring extra rigor (OAuth flow, OpenAPI drift, IA changes, form modals). Backprop turns each repeat-failure into a permanent invariant with a sensor. Repeats become detectable, then preventable.

---

## 14. Open principles — taping to the wall

The seven sentences worth reading every Monday morning.

1. **Agent = model + harness.** A weak harness with a strong model produces vibe-coded slop. A strong harness with a moderate model ships features.
2. **Generated > written wherever a generator exists.** Hand-written status docs rot; generated ones fail loud.
3. **Policy lives in the repo with the code.** When behavior changes, `git blame` tells you why.
4. **Sensors fail loud or they don't exist.** A sensor that emits a warning that nobody reads is debt.
5. **Memory writes are free. Memory extraction is not.** Pre-filter deterministically; reserve LLM for transformation.
6. *(OpenAI-derived principle; exact verbatim wording not confirmed in primary OpenAI source as of 2026-05-02)* **"Instructions decay, enforcement persists."** Telling an agent vs blocking the PR.
7. *(OpenAI verbatim — confirmed in primary source)* **"Human taste is captured once, then enforced continuously on every line of code."**

---

## 15. Glossary

| Term | Meaning |
|------|---------|
| **Harness** | Total system around the model: guides, sensors, data context, scaffolding, evals, sandboxing, escalation. |
| **Guide** | Feedforward control — directs agent before action (system prompt, AGENTS.md, type defs). |
| **Sensor** | Feedback control — verifies after action (linter, type check, eval, AI review). |
| **Computational sensor** | Deterministic check (lint, tsc, structural test). |
| **Inferential sensor** | Model-based check (AI code review, semantic eval). |
| **Grounding context** | Set of facts the agent must know before acting; harness ensures it is current. |
| **Grounding daemon** | Long-lived watcher process that mechanically regenerates `.harness/ground/` on file change. Mostly mechanical; LLM only at extraction boundaries. |
| **WORKFLOW.md** | Symphony's repo-owned policy file: YAML front-matter (config) + Markdown body (per-task prompt). |
| **Mirror checkout** | Parallel git clone at `~/.local/harness/repos/<project>/` where harness operates exclusively, never touching user's working tree. |
| **Run** | One execution attempt of one task by one agent. |
| **Reconciliation** | Orchestrator periodic check that running agents are still working on tasks the tracker says are active. |
| **Stall** | Agent run that has stopped producing events but hasn't terminated. |
| **Vibe-coded** | Confident-looking but ungrounded agent output that becomes canon by accident. |
| **Provenance frontmatter** | YAML header on every doc declaring source, generation, verification timestamps, hash. |
| **Trust posture** | Per-command declaration of confirmation requirement (read-only / write-creating / configuration-changing). |
| **Relevance window** | Portion of agent's loaded context it actually attends to. Short. Smaller is better. |
| **Generator drift** | When a generated artifact's source has changed but the artifact has not been regenerated. |
| **Hot-path LLM arbitration** | Anti-pattern: invoking an LLM on every tool call / write to decide whether to act. Burns tokens whether or not action follows. |
| **Backprop** | Cavekit-derived protocol: every fix introduces a §V invariant + sensor + test naming convention. Repeats become preventable. |
| **§V invariant** | Monotonic-numbered, never-reused canonical rule from backprop. Has a corresponding sensor or E2E case. |
| **Garbage collection cadence** | Background nightly pass scanning drift, opening self-merging cleanup commits. |
| **Quality grade** | Per-module score from GC pass surfaced in Discord `/status`. |
| **Remediation message** | Sensor failure message shaped as actionable agent prompt; consumed by retry loop. |
| **Evidence-file gate** | Pre-push gate requiring SHA256-of-output proof in `.uat-passed`. Bare `touch` rejected. |
| **Cold-start smoke injection** | When task touches startup files, automatically prepend a smoke check to UAT. |
| **Two-zone separation** | Canonical paths vs `.archive/` historical, hook-enforced; agents never see stale by default. |
| **Squares-into-square-holes** | UX rule: harness proposes A/B/C/D before asking for typed input. Operator picks. |
| **Tier ladder** | Tier 0 (Ollama) → Tier 1 (Haiku) → Tier 2 (Sonnet) → Tier 3 (Opus). Per-task-class assignment in `WORKFLOW.md`. |
| **Snapshot pinning** | Run pinned to a git SHA at start; agent reads/writes against that SHA only; no thrash on concurrent changes. |

---

## 16. Recommended reading order

1. This PRIMER end-to-end.
2. `_research/STALENESS_INVENTORY.md` — current doc surface classified.
3. `_research/DISCORD_WHISPER_DESIGN.md` — voice + bot design.
4. `WORKFLOW_GUIDE.md` — operator UX rules + tier ladder + slash surface.
5. `INTEGRATION_PLAN.md` — phased plan against mypal.
6. `FILESYSTEM_LAYOUT.md` — concrete layout under `.harness/`.
7. `MCP_SURFACE.md` — agent tool surface.
8. `UAT_PIPELINE.md` — UAT-on-phone details.
9. `QUESTIONS.md` — answer the residual open items to lock final config.

---

## References

- OpenAI, *Harness engineering: leveraging Codex in an agent-first world.* February 2026. https://openai.com/index/harness-engineering/
- OpenAI, *An open-source spec for Codex orchestration: Symphony.* April 2026. https://openai.com/index/open-source-codex-orchestration-symphony/
- OpenAI, Symphony repository. https://github.com/openai/symphony
- Birgitta Böckeler, *Harness Engineering for Coding Agent Users.* MartinFowler.com, 2026-04-02. https://martinfowler.com/articles/harness-engineering.html
- Ryan Lopopolo, *Extreme Harness Engineering: 1M LOC, 1B toks/day.* Latent Space, 2026. https://www.latent.space/p/harness-eng
- *OpenAI Introduces Harness Engineering.* InfoQ, 2026-02. https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/
- *OpenAI releases Symphony.* Help Net Security, 2026-04-28. https://www.helpnetsecurity.com/2026/04/28/openai-symphony-codex-orchestration-linear/
- JuliusBrussee/cavekit (v4) — single-file SPEC pattern, backprop protocol. https://github.com/JuliusBrussee/cavekit
- thedotmack/get-shit-done — canonical-refs pattern, hypotheses-until-shipped, blocked_by tagging.
- thedotmack/claude-mem — token-cost anti-pattern study.
