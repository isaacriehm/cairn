---
type: primer
status: draft-v4
audience: dual
generated: 2026-05-03
supersedes: docs/PRIMER.md (draft-v3)
---

# Harness — Primer

Read this first. Everything else in `docs/` is reference material that depends on concepts defined here.

---

## 1. The problem

Bad AI output has two root causes. Not "the model is bad."

**Root cause 1: Missing or wrong ground truth.** The AI doesn't know your brand so it makes something generic. It doesn't know what decisions were made so it re-debates them. It doesn't know what tasks were actually finished (vs claimed finished) so it builds on broken ground. It doesn't know what skills or components are available so it invents from scratch. Every gap in ground truth is filled with a guess. Guesses compound.

**Root cause 2: Ambiguity the AI should have resolved before starting.** The spec was vague. The AI picked an interpretation, ran with it, and delivered the wrong thing. Or it encountered a decision point mid-task and took a shortcut rather than asking. If it had surfaced the ambiguity before writing a single file, you would have caught it in 10 seconds. Instead you caught it after three hours of work.

Bad code is a side effect of these two problems, not a primary failure. Fix the ground truth and resolve ambiguity upfront — the code quality follows.

Two secondary problems:

**Documentation rot.** Hand-written docs drift from code. Generated docs are never regenerated. The project's state on disk becomes a lie — tasks marked "done" that weren't, docs describing deleted features, a schema doc six weeks out of date. When you return to a project after two weeks, you can't trust what you read.

**Token waste.** Claude Code requires a file read before any edit, even for append-only operations. Large monolithic docs cost tokens just to load context. The harness is designed around these constraints — compact ledgers, focused rule files, MCP append-only writes that need no prior read.

Harness fixes all of these.

---

## 2. What Harness is

**Harness is a project brain.** It maintains a curated, continuously-fresh ground state for your codebase, injects that state into every Claude Code session, and deterministically evaluates everything the agent produces before it lands.

Three pillars:

| Pillar | What it does |
|--------|-------------|
| **State** | Maintains `.harness/ground/` — a structured ledger of decisions, invariants, canonical docs, quality grades, and the project's live documentation index |
| **Documentation** | Tracks, auto-generates, and gardens all load-bearing docs. Knows what's canonical, what's stale, and what should exist but doesn't. Agents never read stale content. |
| **Enforcement** | Deterministic sensors run on every diff. Assertions from past decisions are evaluated mechanically. Nothing lands without passing. |

GSD falls out naturally: task arrives → spec tightened → Claude Code dispatched → diff sensed → violations trigger self-repair → invariants backprop → state updated. The operator watches it happen; they don't supervise it.

**Autonomy-first.** Harness fixes things. Sensor fails → it retries with a targeted remediation prompt. Docs drift → it regenerates them. Stale content → it archives it. The operator is looped in when the harness genuinely can't decide — not as a checkpoint on every action.

Harness is **project-agnostic**. It detects your stack at adoption time, proposes a sensor and documentation config, and asks you to confirm. No project names, frameworks, or ORMs are hardcoded in Harness. Your project's specifics live in your `.harness/config/workflow.md` extension block.

---

## 3. The ground state

The load-bearing artifact is `.harness/ground/`. Everything the harness knows about your project lives here. It is committed to the repo — not a cache, not a build artifact, not gitignored.

```
.harness/ground/
├── decisions/              — ADRs with machine-checkable assertions
│   ├── DEC-0001.md
│   ├── decisions.ledger.yaml  — compact always-loaded summary (~50 tokens/decision)
│   └── _inbox/             — drafts awaiting confirm (gitignored)
├── invariants/             — §V invariants from backprop (monotonic, never reused)
│   ├── V0001.md
│   └── invariants.ledger.yaml
├── brand/                  — what the product looks/sounds like
│   ├── overview.md         — always injected at SessionStart (< 200 tokens)
│   ├── colors.yaml
│   ├── typography.yaml
│   ├── voice.md
│   └── components.yaml     — component library index
├── product/                — who the users are and what matters to them
│   ├── positioning.md      — always injected at SessionStart (< 300 tokens)
│   └── personas.yaml
├── capabilities/           — what tools and skills are available
│   ├── skills.yaml         — installed skill packs
│   └── mcp-tools.yaml      — available MCP servers beyond harness
├── canonical-map/
│   └── topics.yaml         — topic → authoritative doc path (no fuzzy matching)
├── docs-index/
│   └── index.yaml          — daemon-maintained index of ALL load-bearing docs
├── schema/                 — generated: DB schema dump
├── routes/                 — generated: API endpoint table
├── events/                 — generated: emitter+listener registry
├── quality-grades.yaml     — per-module score (GC-maintained)
├── manifest.yaml           — master file index
└── glossary.md
```

**Key invariants:**
- Agents read ground via MCP tools, not direct file reads.
- Ground is written by the harness daemon, GC, and backprop. Agents do not write ground directly.
- Every entry in `decisions/` and `invariants/` is immutable once accepted. Supersedes chain, not in-place edits.
- The compact ledgers are what gets loaded at SessionStart — full content is fetched on demand via `harness_decision_get`.

---

## 4. Documentation management

Documentation management is a first-class pillar. A project accumulates docs in `docs/`, `AGENTS.md`, `.claude/rules/`, and `.harness/ground/`. Harness owns the health of all of them.

See `DOCS_SPEC.md` for the full specification. Summary:

1. **Generated > hand-written wherever a generator exists.** Schema docs, API maps, event registries — if a generator can produce it, it should. Generated docs fail loud when source diverges; hand-written docs rot silently.
2. **Every load-bearing doc carries provenance frontmatter.** `type`, `status`, `audience`, `generated`, `verified-at`, `source-commits`. The daemon uses this to detect staleness without human involvement.
3. **One canonical doc per topic.** The `canonical-map/topics.yaml` is the registry. Agents call `harness_canonical_for_topic("event-naming")` and get one path back.
4. **Stale goes to archive.** A doc that no longer reflects the codebase is moved to `.archive/<date>/` and replaced. Two zones: canonical (default visible to agents) and historical (only accessible via `harness_query_history`).
5. **Audience tiers.** Every doc is tagged `ai-only`, `dual`, or `human-only`. This controls what ends up in agent context.

The GC doc-gardening pass runs nightly: frontmatter freshness, generator drift, orphan detection, missing coverage, broken links. See `DOCS_SPEC.md §4`.

---

## 5. Honest agent invariants — the sensor stack

Six layers. All deterministic except Layer C.

### Layer F — Pre-execution research + spec tightening (before any code)

Two-part gate. Both run before a single file is touched.

**Part 1 — Research gate.** The agent verifies it has the context it needs for this task type. UI task → confirms brand guidelines and component library are in ground state. Feature task → confirms all in-scope decisions and invariants are loaded. If required context is missing or marked `status: draft`, it surfaces the gap: "No brand guidelines found — this task will produce generic UI." One dialog, one decision: fill the gap now, proceed anyway, or skip. Never silently proceeds with assumptions.

If the task involves a security-sensitive pattern (password hashing, token signing, SQL construction, rate limiting), the research gate checks `capabilities/snippets.yaml` for a blessed implementation. If one exists, it's loaded before any code is written. The agent uses the blessed version, not an invented one. See `DOCS_SPEC.md §3.5`.

**Part 2 — Spec tightener.** One Tier-1 LLM call. Inputs: task body, in-scope decisions, in-scope invariants, existing stubs in affected paths, **spec delta since the in-scope code was last touched** (see §8.4 + `CONTEXT_CONTINUITY_SPEC.md` §10). Outputs: `spec_quality_score`, ambiguities, acceptance criteria gaps, `tightened_spec_proposal`. Score < 7 → at most one A/B/C/D dialog. `/ship-anyway` skips.

**Spec delta surfacing.** When the delta contains superseded invariants or new decisions whose scope overlaps the task, the tightener treats those as the FIRST item in its output — the agent sees "the rules for this code changed since it was last touched" before any acceptance-criteria proposal. Empty delta = no injection, no overhead.

**Ask before starting, not after failing.** The combined cost of one clarifying question is a fraction of the cost of one wrong execution.

### Layer A — Mechanical stub catalog

`.harness/config/stub-patterns.yaml`. Harness proposes patterns at init based on detected stack. Runs on every diff. ~5s, zero tokens. Catches: unimplemented throws, empty bodies, unsafe casts, commented-out blocks, always-undefined optionals.

### Layer B — Self-attestation cross-check

Agent emits `attestation.yaml` on completion. Harness mechanically verifies every claim against the diff: behavior declarations, todo/stub counts, sensor claims, files touched. Lying is harder than telling the truth.

### Layer C — Reviewer subagent

Fresh subagent reads only: `spec.tightened.md`, the diff, in-scope decisions and assertions. NOT the implementer's reasoning. Anti-completionist prompt. Same model — context isolation catches blind spots. For security-sensitive diffs, reviewer explicitly checks query-scope completeness and auth guard coverage.

**Reviewer-triggered DEC capture.** The reviewer isn't just a pass/fail gate — it's also a knowledge extraction layer. When the reviewer finds a non-obvious implementation choice that isn't documented anywhere (not in a DEC, not explained by an invariant), it can propose a DEC draft: "This uses a cursor-based pagination pattern without any explanation. Proposing DEC draft — confirm or discard." The draft goes to `decisions/_inbox/` with `source: reviewer`. The operator sees it at next session start in the pending drafts section. This catches decisions that the implementer made correctly but silently — they become permanent ground truth instead of disappearing into git history.

### Layer D — Project-specific sensors

Registered in `.harness/config/sensors.yaml`. Proposed at init based on detected stack; confirmed per sensor. Computational only (regex, AST, structural). No LLM. Harness package code never references project names — it reads sensor config by key.

**All sensors run on the complete diff, never on individual file edits.** A half-refactored file is supposed to have lint errors — running sensors mid-work is noise that blocks meaningful progress. The attestation.yaml emission is the signal that the agent considers the work semantically complete. That is when sensors run. Not before. See §10 anti-patterns: `Edit-time sensor runs`.

**Copy-safety sensor** — proposed at init for any project with a frontend. Scans JSX text nodes, i18n value strings, and HTML template literals in the diff for internal-pattern leakage: comment markers (`TODO`, `FIXME`, `HACK`, `XXX`), harness citations (`§V\d+`, `TSK-`), path separators, snake_case or multi-underscore identifiers in display strings, and `[PLACEHOLDER]`-style draft markers. Runs as part of the Layer D sweep on the complete diff. A pre-commit catch is the backstop — the write guardian (see §8.3) is the earlier warning.

### Layer E — High-stakes E2E (optional, configurable)

For diffs touching `high_stakes_globs` (operator-configured at init). Real E2E suite or recorded demo. Cross-tenant fixture required where multi-tenancy applies.

### Layer U — UAT confirmation

Before push, the active frontend adapter presents the run's output to the operator. Evidence-file gate: `.uat-passed` must contain SHA256 of the UAT artifact. Bare `touch` rejected.

### Decision-assertions sensor

Every accepted decision carries `assertions`. 11 kinds covering structural, textual, behavioral, and review-hint checks. Evaluated against every diff where scope globs overlap. Failure quotes assertion id, decision id, and the contradicting line.

---

## 6. GSD — task execution

```
[task ingested via active frontend adapter]
    ↓
[F: spec tightener → score ≥ 7, else one clarification dialog]
    ↓
[spec-planner: chunk if needed → child tasks queued FIFO]
    ↓  (per chunk or single task)
[mirror reset to origin/<branch> SHA — pinned]
[Claude Code dispatched with rendered prompt + SessionStart context]
    ↓
[agent works in mirror — user working tree untouched]
    ↓
[agent emits attestation.yaml]
    ↓
[sensor sweep: A → B → D → decision-assertions → C → (E if high-stakes)]
    ↓
  [PASS] → commit + push → backprop → done
  [FAIL] → build remediation prompt → re-dispatch Claude Code (attempt 2)
              ↓
            [PASS] → commit + push → backprop → done
            [FAIL] → escalate to operator with structured findings
    ↓
[U: UAT confirm via active frontend adapter]
    ↓
[backprop: §V invariant → committed]
[daemon: regenerate affected generated docs]
[run closes — state updated]
```

**Self-repair is the default path.** When sensors fail, Harness builds a focused remediation prompt from the exact failure (assertion ID, contradicting line, suggested fix) and re-dispatches. The operator sees none of this — it just works. Only after two failed attempts does Harness surface to the operator, with the full structured failure context already prepared.

The operator is never a checkpoint on mechanical failures. They're the last resort.

---

## 7. Backprop — state grows with the project

Every code-class run that lands a fix produces a §V invariant.

1. Backprop subagent reads: `spec.tightened.md`, the diff, the failure that motivated the fix.
2. Produces: `V<N>.md` in `.harness/ground/invariants/` with a corresponding sensor script or E2E case name.
3. Commits as `chore(invariants): add §V<N> from run #<id>`.

§V IDs are monotonic, never reused. Superseded invariants are marked `status: superseded_by: V<M>`, not deleted. Every future run's decision-assertions sensor automatically picks up new invariants whose scope overlaps the diff.

---

## 8. Claude Code integration

The primary delivery mechanism for ground state. Harness is visible inside Claude Code — not hidden.

### 8.0 Status line

Harness registers a status line in Claude Code (`.claude/settings.json` `statusLine` field). It shows at all times — present but out of the way:

```
⬡ harness  decisions:12  inv:8  task:idle  daemon:✓
```

When a run is active:
```
⬡ harness  decisions:12  inv:8  task:running(src/integrations)  daemon:✓
```

When the daemon is doing something:
```
⬡ harness  decisions:12  inv:8  gc:running  daemon:✓
```

Context bar (token budget usage for the current session's ground state injection) is shown as a compact fraction:
```
⬡ harness  ctx:847/4000  decisions:12  inv:8  task:idle
```

The status line reads from a lightweight state file the daemon maintains at `~/.local/harness/state/<project>/status.json`. No subprocess on every render — just a file read. See `STATUS_LINE_SPEC.md`.

### 8.1 SessionStart hook

Registered in `.claude/settings.json` by `harness init`. On every session start, `harness hook session-start` injects an `additionalContext` block containing (in priority order, token-budgeted):

1. Two-zone reminder — names historical paths, tells agent not to read them directly
2. Decisions in scope of cwd
3. Active invariants in scope
4. Current task spec (if active)
5. Quality grade tail (3 weakest modules)
6. Pending decision drafts
7. MCP tool quick-reference

See `SESSIONSTART_SPEC.md` for the full payload spec.

### 8.2 MCP server

Registered in `.mcp.json` by `harness init`. Started by `harness mcp serve` (stdio transport). Exposes ground state via structured tools — agents traverse by ID and path-glob, never by fuzzy search. See `MCP_SURFACE.md`.

### 8.3 PostToolUse hooks — enrichment, not restriction

**The rule: harness never uses PreToolUse.** PreToolUse blocks tool calls — a buggy hook bricks the session and prevents the agent from making any progress. PostToolUse enriches or warns *after* the tool runs. Crashes are no-ops. The agent always keeps moving.

Two PostToolUse hooks are registered by `harness init`:

#### Read enricher (PostToolUse on `Read`)

When Claude reads a source file containing `// §V0023` or `// TODO(TSK-<id>)`, the enricher intercepts the tool response and prepends a compact citation legend — resolving each ID to its current title and status without a separate MCP call. The legend arrives with the code, not after it.

```
┌─ harness citations ──────────────────────────────────────┐
│ §V0023  → null-check before array destructure  [active]  │
│ TODO(TSK-auth-refactor) → bearer token validation [active]│
└──────────────────────────────────────────────────────────┘
<actual file content unchanged>
```

If 0 citations found: 0 overhead. If the enricher crashes: raw content passes through (PostToolUse never blocks, unlike PreToolUse). Orphaned or superseded citations appear as `[NOT FOUND]` or `[SUPERSEDED]` in the legend — the agent knows immediately without a lookup.

At 3 citations per file × 10 files per run, this saves ~4,500 tokens vs explicit MCP lookups. See `READ_ENRICHER_SPEC.md`.

#### Write guardian (PostToolUse on `Write` and `Edit`)

When Claude writes to a UI-surface file (JSX, TSX, Vue, Svelte, HTML templates, i18n JSON — determined by `copy_safety_globs` in `sensors.yaml`), the write guardian scans the new content for internal-pattern leakage and injects a warning directly into the tool result:

```
⚠ harness:copy-safety — possible internal copy in user-facing string:
  line 47: "TODO: replace with real label" — matches comment-marker pattern
  line 83: "§V0041" — harness citation in display string
Review before moving on. If intentional, add to copy-safety allowlist.
```

The agent sees this immediately after the write — while the file is still in its working context — and can self-correct. This is far better than a pre-commit sensor failure that surfaces after the agent has moved on to other files.

If the guardian finds nothing: 0 overhead. If it crashes: write completes normally. The Layer D copy-safety sensor remains the commit-time backstop. The write guardian is the in-context early warning.

### 8.4 Context continuity — runs survive context limits

Claude Code's context window fills. `/compact` is lossy. The harness solves this without a separate memory system: **git is the memory.**

Every task run uses phased commits. At each natural checkpoint (spec-planner defines them in `spec.tightened.md` when chunking large tasks), the agent commits what it's done so far. If context fills, the next session doesn't need to rely on a summary — it reads the actual git history:

```
harness hook session-start → detects active run → reads:
  git log --oneline <sha-pin>..HEAD    (what was committed)
  git diff HEAD -- <files-in-scope>    (current state of touched files)
  spec.tightened.md checkpoints        (what remains)
```

This generates a structured **handoff block** injected at the top of SessionStart — above decisions, above invariants. The agent resumes with exact knowledge of what was done, what's left, and the state of every touched file.

The handoff block format:
```
## Run handoff — TSK-<id> (resuming)
Completed phases: [phase-1: auth schema], [phase-2: route handlers]
Commits since run start: 3 (see git log above)
Remaining: [phase-3: frontend integration], [phase-4: tests]
Watch out for: <agent-written notes from previous phases, if any>
```

The daemon monitors `ctx_tokens_used` in `status.json`. When it crosses 75% of budget, it writes a `checkpoint.md` to the run dir from the current git state and flags the status line: `task:running(ctx:warn)`. The operator can see it but doesn't need to act — the next session picks up cleanly.

See `CONTEXT_CONTINUITY_SPEC.md` for the full spec.

### 8.5 Harness Lens (VS Code / Cursor extension)

The same citation resolution logic that powers the Read enricher is exposed to humans via the **Harness Lens** — a VS Code/Cursor extension distributed as a separate package.

When you open a source file containing `// §V0023`, the Lens reads `.harness/ground/invariants.ledger.yaml` and renders an inlay hint or hover: *"null-check before array destructure [active]"*. When you hover `// TODO(TSK-auth-refactor)`, it shows the task title and current status. Gutter icons show citation health at a glance (`✓` active, `⚠` superseded, `?` not found).

This means the source file is identical for AI and human. The AI gets citation context via the PostToolUse Read enricher. The human gets it via the Lens. Both read the same authoritative ledger. Neither requires essay JSDoc in the source.

The Lens is out of scope for the initial Harness build — it's a separate package with its own distribution. The resolution logic in `src/hooks/post-tool-use/ledger-cache.ts` is the shared core; the Lens will consume it as a library. See `LENS_SPEC.md` (forthcoming).

### 8.6 Hook priority order

| Hook | Phase | Purpose |
|------|-------|---------|
| `SessionStart` | 1 — first | Inject curated ground state + run handoff if resuming |
| `PostToolUse` (Read) | 2 — on every Read | Enrich inline citations with live ground state |
| `PostToolUse` (Write/Edit) | 2 — on writes to UI files | Copy-safety warning |
| `UserPromptSubmit` | 3 | Route `/direction` into decision-capture |
| `Stop` | 4 | Backprop trigger; checkpoint write if run active |
| `PreToolUse` | **Rejected** | Blocks tool calls. Buggy = bricked session. See §10. |

*(For human-readable citation context in the editor, see §8.5 — Harness Lens.)*

---

## 9. Adoption — `harness init`

One command. One pass. No interrogation.

1. **Mechanical detection** — inspects repo: ORM files, framework markers, language, CI config, existing docs. No LLM.
2. **LLM mapper** (Tier 2) — reads gitignore-aware repo summary, proposes: pilot module, sensor list, doc generator list, `<slug>:` extension block.
3. **Single confirm dialog** — presents full proposal as one batched dialog. At most 2 questions. Defaults accept everything. `/ship-anyway` accepts all.
4. **Writes:** `.harness/` layout, `.mcp.json`, `.claude/settings.json`, `AGENTS.md` (if absent), `workflow.md` with `<slug>:` block.
5. **Initial ground state** — runs detected generators, populates manifest, seeds `canonical-map/topics.yaml`.

See `INIT_SPEC.md` for the full adoption UX spec.

---

## 10. Anti-patterns

| Anti-pattern | Why rejected |
|---|---|
| **PreToolUse hook for any purpose** | Buggy PreToolUse bricks the session — it blocks the tool call entirely. PostToolUse is always preferred: it enriches the response without blocking, and crashes are no-ops. SessionStart + walker exclusion handles two-zone enforcement; the read enricher (PostToolUse) handles citation resolution. |
| **Edit-time sensor runs** | Running lint, build, or tests after every file save or Edit call. A half-refactored codebase is supposed to fail lint. Sensors on intermediate states produce noise that blocks the agent from making meaningful progress (the exact failure mode of "run ESLint after every edit"). Sensors run exactly once: on the complete diff, after the agent emits attestation. Not before. |
| **Interrupting the agent mid-flow** | The agent's job is to work. The harness's job is to evaluate the output. These are sequential, not interleaved. The only valid reason to interrupt a running agent is a spec contradiction so clear it's cheaper to abort than to finish and repair. That threshold is high. |
| **One-big-AGENTS.md** | Crowds out task/code context. AGENTS.md = TOC, ~150 lines max. |
| **Hot-path LLM arbitration** | LLM on every tool call/write. Burns tokens whether or not action follows. Pre-filter deterministically. |
| **Confidence scores as gates** | No model-issued confidence in pass/fail decisions. Deterministic sensors only. |
| **Mocked/unit tests** | Sensors and E2E with real infra only. |
| **Branches and PRs (solo mode)** | Direct commits to main. Mirror checkout isolates the user's working tree. |
| **Sequential operator interrogation** | At most 2 questions per operator turn. Smart defaults eliminate the rest. |
| **Hardcoded project names in Harness code** | Harness is project-agnostic. Project specifics live in `workflow.md` `<slug>:` block. |
| **Agents writing to ground directly** | Ground is written by daemon, GC, backprop. Agents read via MCP. |
| **Backward-compat shims** | Hard cutovers. No deprecation banners. |
| **Stale doc with `[STALE]` banner** | Stale → archive. |
| **Explanatory inline comments** | Code should explain itself. If it doesn't, fix the code. Comments that explain rot silently and mislead the next agent. Two citation types are legal: `// §V<N>` (invariant), `// TODO(TSK-<id>)` (linked task). DEC-id comments are **banned** — decisions change and the comment won't update. One non-citation line is allowed only when the constraint is non-obvious and doesn't rise to a DEC: `// non-greedy: catastrophic backtracking on untrusted input`. No essays. If it needs more than one line, it's a decision. |
| **Essay JSDoc blocks** | A 20-line JSDoc explaining timing attack defense, cost parameters, and a rotation script is three things in the wrong place: a decision (why we use a dummy hash), an invariant (login must call verify even for missing users), and a runbook (how to rotate). The AI should not be writing essay JSDoc — stop there. If any of that content rises to the level of a DEC or runbook, it gets captured through the normal `/direction` flow or an explicit operator ask. The code gets `// §V<N>` and nothing else. This pattern — "AI writes an essay, the essay drifts, a different run writes a different essay on the same concept" — is exactly the documentation rot problem Harness exists to prevent. Human-readable context for citations is delivered via the Harness Lens editor extension, not via source comments. |
| **Run notes as permanent documentation** | `notes.md` is ephemeral context for the current run. "Tried JWT, abandoned — CSP header conflict." It exists to help handoff continuity, not to permanently document decisions. If a run note contains something future code must follow, capture it as a DEC before the run closes. When the run closes, notes.md moves to `tasks/done/` and never re-enters future sessions. |

---

## 11. Principles

1. **Agent = model + harness.** A weak harness with a strong model produces vibe-coded slop.
2. **Autonomy-first.** Fix it, don't flag it. Escalate only when genuinely stuck.
3. **Ask before starting, not after failing.** Ambiguity costs nothing to resolve upfront. It costs double to fix after execution.
4. **The AI cannot mark work done. Only sensors can.** Claimed completion means nothing. Verified completion means everything.
5. **Ground truth must be complete.** A gap in ground state is filled with a guess. Guesses compound.
6. **Generated > hand-written wherever a generator exists.**
7. **Policy lives in the repo.** When behavior changes, `git blame` tells you why.
8. **Token efficiency is a design constraint.** Compact ledgers, focused rule files, append-only MCP writes, on-demand full content. Every token spent loading context is a token not spent doing work.
9. **Sensors fail loud or they don't exist.** A warning nobody reads is debt.
10. **Instructions decay. Enforcement persists.**
11. **Human taste is captured once, then enforced continuously.**
12. **Visible, not invisible.** The operator should always know what Harness is doing — at a glance, without asking.
13. **Sensors are diff-level gates, not edit-level observers.** An intermediate state is not a state worth evaluating. The agent works freely until attestation; then sensors run once on the complete diff.
14. **Git is the memory.** Nothing that matters exists only in the context window. Phased commits mean every session can reconstruct exactly what was done without relying on a lossy summary.
15. **Warn in-context, enforce at commit.** The write guardian warns while the agent can still act on it. The sensor sweep enforces before the commit lands. Two layers, right timing for each.

---

## 12. Reading order

1. This file
2. `DOCS_SPEC.md` — documentation management in detail
3. `ARCHITECTURE.md` — package layout + boundaries
4. `MCP_SURFACE.md` — MCP tool catalog
5. `FILESYSTEM_LAYOUT.md` — disk layout
6. `SESSIONSTART_SPEC.md` — hook payload spec
7. `DAEMON_SPEC.md` — grounding daemon
8. `INIT_SPEC.md` — adoption UX
9. `READ_ENRICHER_SPEC.md` — PostToolUse citation enricher + write guardian
10. `CONTEXT_CONTINUITY_SPEC.md` — phased commits, git-as-memory, session handoff
11. `UAT_PIPELINE.md` — UAT confirm pipeline (core sections current; adapter rendering sections need revision)
12. `LENS_SPEC.md` — Harness Lens VS Code/Cursor extension (forthcoming — out of scope for initial build)
