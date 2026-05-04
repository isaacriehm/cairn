---
type: spec
status: draft-v2
audience: dual
generated: 2026-05-04
supersedes: DOCS_SPEC.md (draft-v1)
depends-on:
  - docs/PRIMER.md
  - docs/FILESYSTEM_LAYOUT.md
  - docs/DAEMON_SPEC.md
---

# Harness — Documentation & State Management Spec

## 0. The real purpose

The documentation system exists to make **the true state of the project knowable at any time** — by you when you return after two weeks, and by any fresh AI session that opens this project.

Not "keeping docs current." Not "maintaining a wiki." One question: **what is actually true about this project right now?**

Without this, the AI fills in the gaps with guesses. It doesn't know your brand so it makes something generic. It doesn't know your component library so it invents one. It doesn't know what tasks were actually finished (vs claimed finished) so it builds on broken ground. Every ambiguity the AI resolves by guessing compounds the next time.

The docs system is the answer to every guess the AI would otherwise make.

---

## 1. What needs to be knowable

Six categories. Every one of these must be answerable from `.harness/ground/` without reading the source code:

| Question | Ground state source |
|----------|---------------------|
| What features are actually complete? | `tasks/done/` + attestation records (mechanically verified) |
| What decisions are binding right now? | `decisions/decisions.ledger.yaml` → full ADRs on demand |
| What does this product look like? | `brand/` — colors, typography, component library, design system |
| Who are the users? | `product/personas.yaml` — user types, goals, constraints |
| What tools and skills are available? | `capabilities/skills.yaml` — installed skill packs, available tools |
| What's in progress or broken? | `tasks/active/` + `quality-grades.yaml` + attention queue |

If any of these is unanswerable, that's a gap the harness surfaces — not something the AI silently fills with assumptions.

---

## 2. The honesty contract

**The AI cannot mark work as done. Only sensors can.**

A task moves from `active` to `done` when and only when:
- Attestation cross-check passed (AI's claims match the diff mechanically)
- All registered sensors passed against the diff
- No new stubs or TODOs introduced (Layer A scan)

Nothing else. Not the AI saying "I'm finished." Not a commit message that says "feat: complete X." The sensors are the gatekeeper, not the agent.

This eliminates the failure mode where:
- AI creates 100 files claiming they implement a feature
- Half are empty or stub implementations
- Agent reports "done"
- You move on
- Next session builds on broken ground

**If sensors haven't run and passed, the task is not done.** Full stop.

### 2.1 Task state is mechanical, not narrative

Task states in `.harness/tasks/active/<id>/status.yaml`:

```
queued → tightening → running → sensing → reviewing → uat → done
                                         ↓ (sensor fail)
                                    self-repair (attempt 2)
                                         ↓ (fail again)
                                    attention (operator required)
```

A task stuck in `sensing` is not done. A task in `self-repair` is not done. The only terminal positive state is `done` — reached only via the mechanical gate above. The status line always reflects this honestly.

### 2.2 No orphaned work artifacts

The harness owns `.harness/`. Source code lives in the rest of the repo. The AI does not create:
- Ad-hoc remediation folders at the repo root
- Temp directories with work tracking files
- "Progress" markdown files outside of `.harness/tasks/`
- Any file that claims to track state outside the harness layout

If the AI creates any of these, GC detects them on the next sweep and archives them. The rule is enforced by the layout spec (`FILESYSTEM_LAYOUT.md`) and by GC's orphan detection pass, which scans for any file matching state-tracking patterns (e.g. `REMEDIATION*.md`, `TODO*.md`, `PROGRESS*.md`, `FIXES*.md`) outside of `.harness/` and archives them.

The repo stays clean. The project's state lives exactly where it's supposed to live and nowhere else.

---

## 3. Ground state — full taxonomy

`.harness/ground/` carries everything the AI needs to do your job well. Six categories:

### 3.1 Decisions (`decisions/`)

Binding architectural and product decisions with machine-checkable assertions. The AI never re-debates these. The sensors enforce them.

```
decisions/
├── decisions.ledger.yaml     — compact summary, always loaded at SessionStart
├── DEC-0001.md               — full ADR, fetched on demand via MCP
└── _inbox/                   — drafts awaiting operator confirm (gitignored)
```

Ledger format (token-cheap, loaded wholesale):
```yaml
- id: DEC-0042
  title: actor_user_id denormalization
  status: accepted
  scope_globs: [src/dashboard/**]
  decided_at: 2026-05-01
```

Full ADR fetched via `harness_decision_get("DEC-0042")` only when needed. This is the **compact ledger → full content on demand** pattern. It minimizes token cost while making all decisions accessible.

### 3.2 Invariants (`invariants/`)

Rules extracted from past bugs via backprop. Each has a linked sensor. The AI cannot violate these without being caught.

Same compact ledger → full content on demand pattern as decisions.

### 3.3 Brand (`brand/`)

**First-class ground state.** Not an afterthought. Not "docs/design/brand somewhere". Loaded at session start for any task touching UI, copy, or user-facing surfaces.

```
brand/
├── overview.md          — one-paragraph brand summary (always loaded, < 200 tokens)
├── colors.yaml          — primary/secondary/semantic palette with hex values
├── typography.yaml      — font families, sizes, weight conventions
├── voice.md             — tone, vocabulary, what to avoid
├── components.yaml      — component library index (name, purpose, import path)
└── examples/            — screenshots or HTML snippets of correct usage
```

`overview.md` is tiny on purpose — it's always injected at session start regardless of task type. The full brand files are fetched via `harness_canonical_for_topic("brand-colors")` etc. only when the task is UI-related.

The init flow explicitly asks: "Where are your brand guidelines? I'll catalog them." If none exist, it creates stubs and marks them `status: draft` — a signal to the AI that brand context is incomplete, it should ask before making design decisions.

### 3.4 Product (`product/`)

Who the users are. What they care about. What they don't.

```
product/
├── personas.yaml        — user types with goals, pain points, technical level
├── positioning.md       — what this product is and isn't (< 300 tokens)
└── constraints.yaml     — hard constraints (accessibility, legal, performance budgets)
```

`positioning.md` is injected at session start always. The AI should never have to guess what the product is trying to do.

### 3.5 Capabilities (`capabilities/`)

What tools and skills are available in this session. This is the thing the AI should check before deciding HOW to do something.

```
capabilities/
├── skills.yaml          — installed skill packs with descriptions and when to use them
├── mcp-tools.yaml       — available MCP tools beyond harness (registered in .mcp.json)
├── snippets.yaml        — blessed implementations for security-sensitive patterns
└── constraints.yaml     — what's NOT available (no network in CI, no browser in headless, etc.)
```

Before any task execution, the pre-execution research gate (§5) loads this. "I need to design a UI" → check `skills.yaml` for a design skill before doing anything. "I need to fetch an API" → check `mcp-tools.yaml` for a connector. The AI uses what's available rather than inventing from scratch.

**`snippets.yaml` — blessed implementations.** A catalog of security-sensitive patterns that have been reviewed and approved for this project. Entries include the pattern name, the blessed implementation (inline or by file reference), the decision that approved it, and the scope where it applies. Examples: password hashing (approved bcrypt cost factor + dummy-hash-on-miss pattern), JWT signing (approved algorithm + expiry policy), rate limiting (approved middleware call), SQL parameterization (approved query builder call).

When the pre-execution research gate (Layer F) detects that a task involves a pattern in `snippets.yaml`, it loads the blessed implementation before the agent starts. The agent uses the blessed version rather than inventing one from first principles. This prevents the "AI googles a Stack Overflow answer" failure mode for patterns where correctness is security-critical. Deviating from a blessed snippet triggers a decision-assertions sensor violation unless a new DEC explicitly supersedes it.

### 3.6 Generated extracts (`schema/`, `routes/`, `events/`)

Mechanically produced. Never hand-written. Always current (daemon regenerates on source change).

```
schema/tables.yaml       — DB tables, columns, types, relationships
routes/endpoints.yaml    — API endpoint surface
events/registry.yaml     — event emitter/listener pairs
```

These are the AI's eyes into the codebase structure. Without them, it reads source files to understand the shape of the data — expensive and error-prone. With them, `harness_ground_get("schema")` gives the full picture in one cheap call.

### 3.7 Canonical map (`canonical-map/topics.yaml`)

Single registry of which doc is authoritative for each topic. The AI calls `harness_canonical_for_topic("event-naming")` and gets one path. No searching. No "I found 3 docs about this, let me synthesize." One answer.

### 3.8 Scope index (`scope-index.yaml`)

A forward map from every file path in the repo to the decisions and invariants that apply to that file. Built at init by the Tier-2 mapper LLM (semantic classification, not glob matching) and maintained incrementally by the daemon as files are added, moved, or deleted.

Shape:

```yaml
# .harness/ground/scope-index.yaml
generated: 2026-05-04T03:00:00Z
files:
  src/auth/login.ts:
    decisions: [DEC-0042, DEC-0089]
    invariants: [V0041, V0052]
  src/auth/logout.ts:
    decisions: [DEC-0042]
    invariants: [V0041]
  src/dashboard/index.tsx:
    decisions: [DEC-0017]
    invariants: []
  .eslintrc.json:
    unscoped: true   # explicit "no rules apply" — suppresses GC scope-coverage warning
```

**Why a forward index.** The previous design evaluated `scope_globs` at every hook fire — reactive, lossy, and silent on coverage gaps. A file that should be in scope but doesn't match any glob was uncovered with no signal. The forward index turns this into an O(1) lookup AND makes coverage gaps visible (any file with no entries surfaces in the GC scope-coverage pass — see §7).

**Maintenance.** The index is a derived artifact: regenerable from the source-of-truth decisions/invariants by re-running the mapper. Operators don't hand-edit it. Decisions and invariants still carry `scope_globs` in their frontmatter — those are the SEED INPUT to mapper classification, not the runtime lookup mechanism.

**Consumers.**
- PostToolUse hooks read this file once per invocation (cached by mtime) and look up `files[<path>]` directly. No glob compilation, no walk, no per-call traversal cost. See `READ_ENRICHER_SPEC.md` §6 + Write Guardian "Scope-index integration."
- Spec delta (see `CONTEXT_CONTINUITY_SPEC.md` §10) uses scope-index reverse lookup when a task's `target_path_globs` is empty — find files referenced by the task scope and compute the cutoff from there.
- GC's scope-coverage pass (§7) walks the index against the filesystem in both directions to surface gaps.

**Schema.** Each entry's value is `{ decisions: string[]; invariants: string[]; unscoped?: true }`. The `unscoped: true` flag is for files that should never carry decisions/invariants (config, generated, vendored) — it suppresses GC scope-coverage warnings without leaving the file invisible.

---

## 4. Pre-execution research gate

**Before writing a single file, the AI must verify it has the context it needs.**

This is the fix for "nuke the design and it makes generic shit." The research gate has three inputs:

1. **Task body** — what the operator asked for.
2. **Current ground state** — the decisions, invariants, brand, product, and capabilities that apply to the affected paths (resolved via the scope index — see §3.8).
3. **Spec delta** — what changed in ground state since the affected code was last touched (see `CONTEXT_CONTINUITY_SPEC.md` §10). Computed mechanically: `git log` for last-touch SHA + ledger diff between that SHA and HEAD. Empty delta → skipped. Non-empty delta → first item in tightener output ("rules for this code changed: …").

The combination is non-redundant: current state tells the agent what's true now, the delta tells it what's *new* since the code was authored. The pair avoids the failure mode where an agent re-litigates a since-superseded decision because it can't tell which decisions are actively relevant to the task vs. ambient noise.

Per task type, the agent verifies the required context items exist:

| Task type | Required context |
|-----------|-----------------|
| Any UI / frontend | `brand/overview.md`, `brand/components.yaml`, `product/personas.yaml`, `capabilities/skills.yaml` |
| Any API / backend | `schema/tables.yaml`, `routes/endpoints.yaml`, in-scope decisions |
| Any copy / content | `brand/voice.md`, `product/positioning.md`, `product/personas.yaml` |
| Any new feature | In-scope decisions, in-scope invariants, `capabilities/skills.yaml` |
| Any refactor | In-scope decisions, quality grades for affected module |

The SessionStart hook loads the always-injected items (overview, positioning, decisions in scope). The research gate runs as part of spec tightening (Layer F) — the tightener checks whether required context items exist in ground state. If they don't:

- If the gap is resolvable by the AI (e.g. the brand overview exists but just isn't in ground state yet — it can read it): the tightener adds it to the session context before proceeding.
- If the gap is genuinely missing (no brand guidelines exist at all): the tightener surfaces this as a blocker: "No brand guidelines found. This task will produce generic UI. Options: [provide brand context | proceed anyway | skip]."

The operator gets one dialog maximum. Not a series of questions — one structured prompt.

### 4.1 Ambiguity resolution before execution

The spec tightener (Layer F) also checks for genuine ambiguities in the task itself:

- Multiple valid interpretations of the spec
- Spec requires information not in ground state (e.g. "match the existing button style" — but which button? which file?)
- Spec conflicts with an existing decision

These surface as the **only** questions asked before execution. At most 2. If the operator doesn't answer, the tightener takes the most defensible default and notes it in `spec.tightened.md`.

The principle: **ask before starting, not after failing.**

---

## 5. Token efficiency — structural principles

Every doc and tool in the ground state is designed to minimize token cost. Claude Code's read-before-edit constraint is real; the harness is built around it.

### 5.1 Compact ledger → full content on demand

Never load the full content of every decision, invariant, or doc at session start. Load the compact ledger (50 tokens per entry). Fetch full content only when the task needs it.

```
SessionStart injects:        decisions.ledger.yaml   (~50 tokens × N decisions)
Agent needs DEC-0042 body:   harness_decision_get("DEC-0042") → full ADR
```

The ledger is always cheap. The full fetch is always targeted.

### 5.2 MCP writes require no prior read

`harness_record_decision`, `harness_archive` — these are append-only primitives. The server writes without the agent reading first. No tokens burned reading a file to append one line.

This is the design target for all ground state writes. If the agent needs to add an invariant, it calls `harness_record_decision`. It does not Read the invariants ledger, append to it, Write it back.

For project files (non-ground-state), the read-before-edit constraint still applies. Mitigation: keep rule files scoped and small. A `.claude/rules/event-naming.md` that's 30 lines is cheap to read. A 300-line monolithic `ENGINEERING_STANDARDS.md` is not. The harness splits rules into focused single-topic files and enforces this at init.

### 5.3 Rule files are focused, not monolithic

At init, existing large rule files / AGENTS.md content is analyzed and split:
- Each rule gets its own `.claude/rules/<topic>.md`
- Max ~50 lines per rule file
- Claude Code auto-loads rules by path glob — scoped rules only load when the agent is in the relevant path

This means an agent working in `src/frontend/` loads `rules/ui-conventions.md` but not `rules/db-conventions.md`. Relevant context only.

### 5.4 Ground state files are machine-readable first

`schema/tables.yaml`, `routes/endpoints.yaml`, `capabilities/skills.yaml` etc. are YAML, not markdown prose. The agent parses one clean structure, not a document it has to interpret. Less tokens, less ambiguity.

`brand/overview.md` is the exception — it's prose, but deliberately tiny (< 200 tokens) and always injected. Everything else in brand is YAML or structured.

### 5.5 Always-injected vs on-demand

SessionStart injects a fixed budget of always-relevant context:

| Content | Max tokens | Always? |
|---------|-----------|---------|
| Two-zone reminder | ~100 | Always |
| `brand/overview.md` | ~200 | Always |
| `product/positioning.md` | ~300 | Always |
| `decisions.ledger.yaml` (in-scope) | ~50 × N | Always (in scope) |
| `invariants.ledger.yaml` (in-scope) | ~50 × N | Always (in scope) |
| Active task spec | ~300 | If task active |
| Quality grades tail | ~100 | Always |
| MCP tool quick-ref | ~150 | Always |

Everything else is on-demand. The total always-injected budget is configurable in `workflow.md` (`session_start_budget_tokens`, default 4000). When budget is exceeded, lower-priority items are dropped — decisions/invariants ledgers are never dropped.

### 5.6 Read-time citation enrichment (PostToolUse)

The read enricher eliminates the most expensive token pattern in a typical run: the agent reads a file, sees `// §V0023`, and makes a `harness_invariant_get` call to understand it. That call costs ~150 tokens (prompt + response). A file with 3 citations costs ~450 tokens in lookups before the agent can even start working.

The read enricher intercepts the `Read` tool response via PostToolUse and prepends a citation legend resolved directly from the on-disk ledgers. The agent sees:

```
┌─ harness citations ───────────────────────────────────────┐
│ §V0023  → null-check before array destructure  [active]   │
│ §V0041  → no direct db writes in route handlers [active]  │
│ TODO(TSK-auth) → bearer token validation        [active]  │
└───────────────────────────────────────────────────────────┘
```

...then the code. No MCP call. No round-trip. The legend is ~30 tokens vs ~450 tokens in MCP lookups.

Superseded or orphaned citations appear as `[SUPERSEDED by §V<M>]` or `[NOT FOUND]` — the agent knows to act on them without a separate check.

If 0 citations: 0 legend, 0 overhead. PostToolUse crashes pass through raw content (never bricks the session). See `READ_ENRICHER_SPEC.md` for the full implementation spec.

---

## 6. Documentation lifecycle — honest state edition

### 6.1 A doc is honest or it isn't

Every doc in the canonical zone has exactly one of two states:
- **Honest**: content accurately reflects the current state of the project. Mechanically verified by daemon.
- **Needs reverification**: source has changed since last verification. Flagged in docs-index. Not archived — still the best available truth — but agents see a caveat.

There is no "probably fine." The daemon knows. If it can't verify, it flags.

### 6.2 Task completion docs are the most important honesty contract

`.harness/tasks/done/<id>/attestation.yaml` is the record of what was actually verified complete. This is the canonical answer to "was this task actually finished?"

It contains:
- Every sensor result (pass/fail/skipped)
- Attestation cross-check result
- SHA of the diff that was verified
- Timestamp

If a task claims `status: done` but has no valid `attestation.yaml` with passing results, GC flags it as `status: integrity-error` and adds it to the attention queue. No silent fake-completion.

### 6.3 Birth, maintenance, archival — same as before but with honesty framing

**Birth:** doc is created in canonical zone. Daemon picks it up, validates frontmatter, adds to docs-index. If `status: draft`, the AI sees it as "work in progress" and does not treat it as authoritative.

**Maintenance:** daemon re-verifies periodically. Generated docs are regenerated on source change. Hand-authored docs are flagged when their source commits have new changes since last verification.

**Archival:** stale, superseded, or orphaned docs move to `.archive/`. Never deleted. The harness never archives a doc that's the most recent record of a completed task — those stay in `tasks/done/` permanently.

---

## 7. GC honesty passes

The five GC passes (from `DOCS_SPEC.md v1`) now have an explicit honesty orientation:

| Pass | Honesty check |
|------|--------------|
| Frontmatter freshness | "Is this doc still accurate?" — not just "is the date recent?" |
| Generator drift | "Does the generated doc match the source?" — auto-fix if not |
| Orphan detection | "Does this doc reference things that still exist?" — archive if not |
| Missing coverage | "Is there a doc for this thing that should have one?" — create stub |
| Broken links | "Do the links in this doc go somewhere real?" — auto-fix or surface |

New pass: **Completion integrity**

For every task in `tasks/done/`:
- Verify `attestation.yaml` exists and has passing sensor results
- Verify the attested SHA is in `git log` (the commit actually happened)
- Verify the claimed `files_touched` actually changed between parent commit and attested SHA

If any check fails: task is moved back to `tasks/active/<id>/` with `status: integrity-error`. Harness adds an attention item. Next agent session sees the task as incomplete.

This catches the "it said done but wasn't" failure mode at the source.

New pass: **Citation integrity**

GC scans every source file in the repo (respecting `.gitignore`) for inline citation patterns:

- `// §V<N>` — invariant citation
- `// TODO(TSK-<id>)` — linked task

For each `§V<N>` found:
- If invariant `V<N>` does not exist in `invariants.ledger.yaml`: **orphaned citation** → add to attention queue with file + line number. Agent on next run strips it.
- If invariant `V<N>` has `status: superseded_by: V<M>`: **stale citation** → attention queue. Agent updates `§V<N>` → `§V<M>`.

For each `TODO(TSK-<id>)` found:
- If task `<id>` exists in `tasks/done/`: **resolved TODO left in code** → auto-flag. Layer A catches these at commit time, but GC is the backstop.
- If task `<id>` does not exist anywhere: **orphaned TODO** → attention queue.

DEC-id comments (`// DEC-<id>`) are banned entirely (see PRIMER.md §10 anti-patterns). If GC encounters any, it logs them as policy violations in the attention queue. No auto-fix — agent removes them on the next touching run.

This pass is purely mechanical — regex scan over source, ledger lookup, no LLM. Runs as part of nightly GC.

New pass: **Scope coverage**

For every file in the repo (gitignore-aware walk), check that an entry exists in `.harness/ground/scope-index.yaml` (see §3.8). Files with no entry aren't necessarily wrong — many files (config, generated, vendored) genuinely have no decisions or invariants in scope — but uncovered files are a signal worth surfacing.

The pass also detects scope drift in the other direction: every entry in the scope-index is checked against the filesystem. Entries pointing to files that no longer exist (after a restructure, rename, or delete) are flagged. The daemon's incremental updates should keep this in sync, but the GC pass is the periodic backstop.

Findings are advisory (`severity: "warn"`), surfaced in the attention queue, and resolved by either:
- Re-running the mapper to refresh the index (`harness scope rebuild`).
- Manually editing the file's entry in `scope-index.yaml` (rare — the index is regenerable).
- Marking the file as `unscoped: true` in the index for files that should never have decisions/invariants (e.g. `.eslintrc.json`, generated files).

This pass is mostly mechanical — filesystem walk + scope-index lookup. The mapper LLM call only fires when `harness scope rebuild` is invoked explicitly, never on the GC cron.

---

## 8. Brand and product ground state at init

During `harness init`, after the stack detection and mapper run, there's a dedicated ground state seeding phase:

```
  Building project brain...

  Brand
    ? No brand/overview.md found
      → Creating stub at .harness/ground/brand/overview.md
      → Status: draft (AI will ask before making design decisions)

  Product
    ? No product/personas.yaml found
      → Creating stub at .harness/ground/product/personas.yaml
      → Status: draft

  Capabilities
    ✓ skills.yaml          3 skill packs detected in .claude/skills/
    ✓ mcp-tools.yaml       2 MCP servers in .mcp.json
```

Stubs are not empty — they're templated with the right structure and marked `status: draft`. The AI can see them and knows they need filling. When it encounters a draft brand file before a UI task, it asks the operator to fill it in rather than proceeding with generic assumptions.

The operator can fill these at any time. `harness init` doesn't block on them — it creates the stubs and moves on.
