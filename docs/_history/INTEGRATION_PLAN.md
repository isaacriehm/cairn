---
type: integration-plan
status: draft-v2
audience: dual
generated: 2026-05-02
depends-on:
  - docs/orchestration/PRIMER.md
  - docs/orchestration/FILESYSTEM_LAYOUT.md
  - docs/orchestration/MCP_SURFACE.md
  - docs/orchestration/UAT_PIPELINE.md
  - docs/orchestration/WORKFLOW_GUIDE.md
  - docs/orchestration/_research/STALENESS_INVENTORY.md
  - docs/orchestration/_research/DISCORD_WHISPER_DESIGN.md
revision-trigger: When QUESTIONS.md residual items are answered, regenerate the affected phases only.
---

# Integration Plan — Harness for mypal., portable to any project

> **Superseded framing (2026-05-04):** Sections that describe Harness as a single
> `@devplusllc/harness` package are historical. The product is now four
> workspace packages (`harness-core`, `harness-runtime`,
> `harness-frontend-discord`, `harness-frontend-stub`) plus the umbrella
> `harness` re-export. See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the
> locked layered model. The phase plan below remains accurate as a record of
> what was built and in what order, but the package boundary is wrong.

## 0. Goal

Build a Symphony-shaped harness as a **generic monorepo workspace package** (`@devplusllc/harness`) plus an in-repo `.harness/` configuration directory. Mypal is the proving ground; the package extracts cleanly to any other project via `npx @devplusllc/harness init <repo-dir>`.

The harness:

1. Runs as two long-lived TypeScript processes — `harness watch` (grounding daemon) and `harness run` (orchestrator).
2. Operates against a **parallel mirror checkout** at `~/.local/harness/repos/<project>/` — never touches the user's working tree.
3. Accepts text + voice from Discord. Channel-per-task lifecycle (📋 backlog / 🟢 active / 📦 archive).
4. Local Whisper (whisper.cpp via Homebrew) for voice transcription. Audio never written to disk.
5. Single-task FIFO pipeline (concurrency = 1). New task while one runs → queued.
6. Direct commits to `main` after sensor + reviewer + UAT pass. **No branches, no PRs.**
7. Grounding state on filesystem only. No Postgres. No Notion. Two-zone canonical/historical separation, hook-enforced.
8. Honest-agent invariants stack (Layers F, A, B, C, D, E, U + decision-assertions sensor).
9. Backprop protocol — every fix introduces a §V invariant + sensor.
10. Garbage collection cadence — nightly background drift sweep, auto-merging safe-class refresh commits.
11. Tier ladder for model selection (Ollama → Haiku → Sonnet → Opus) per task class.
12. MCP server (`harness-mcp`) exposes structured graph traversal + append-only writes, registered for Claude Code and Codex.

---

## 1. Architectural sketch

```
                                ┌────────────────────────────────────────────┐
                                │  Discord (operator console — mobile + desktop) │
                                │  category: 📋 backlog / 🟢 active / 📦 archive  │
                                │  channel-per-task, voice + text + buttons   │
                                └─────────────────┬──────────────────────────┘
                                                  │ discord.js gateway + REST
                                ┌─────────────────▼──────────────────────────┐
                                │  harness/ (workspace package, port 3004)   │
                                │                                            │
                                │  ┌───────────────────────────────────┐     │
                                │  │  process A: harness watch         │     │
                                │  │  (grounding daemon — chokidar)    │     │
                                │  │  • watches user repo + mirror     │     │
                                │  │  • mechanical regen of ground/    │     │
                                │  │  • frontmatter freshness check    │     │
                                │  │  • drift detection (no LLM)       │     │
                                │  └───────────────────────────────────┘     │
                                │                                            │
                                │  ┌───────────────────────────────────┐     │
                                │  │  process B: harness run           │     │
                                │  │  • discord ingress                │     │
                                │  │  • whisper pipeline               │     │
                                │  │  • intent classifier (Tier 0/1)   │     │
                                │  │  • spec tightener (Layer F)       │     │
                                │  │  • orchestrator (FIFO, conc=1)    │     │
                                │  │  • agent runner (claude --p)      │     │
                                │  │  • sensor runners                 │     │
                                │  │  • UAT pipeline                   │     │
                                │  │  • garbage collector (cron)       │     │
                                │  │  • harness-mcp server             │     │
                                │  └─────┬─────────────────────────────┘     │
                                └────────┼───────────────────────────────────┘
                                         │ subprocess.spawn
                                ┌────────▼─────────┐
                                │  Claude Code     │
                                │  + .claude/      │
                                │     agents/*     │
                                │     skills/*     │
                                │     rules/*      │
                                │     hooks (gate) │
                                └────────┬─────────┘
                                         │ writes to mirror
                                ┌────────▼─────────────────────────┐
                                │  ~/.local/harness/repos/mypal/   │
                                │  (mirror checkout — pinned to    │
                                │   origin/main SHA at run start)  │
                                └──────────────────────────────────┘
                                         │ git push origin main
                                ┌────────▼─────────┐
                                │  origin (GitHub) │
                                └──────────────────┘

User's working tree at ~/Projects/mypalcrm/ — never touched by harness. Pulls when convenient.
```

---

## 2. Trial-run acceptance criteria *(2-week timebox)*

The harness is "working" when **all five** are true within the timebox:

1. **Voice → grounded review.** Discord voice note `"review the integrations module for cross-tenant leaks"` produces a markdown report posted to the originating channel within 5 minutes. Report cites only file paths that exist at run-pin SHA. (Sensor: post-run path-existence check finds zero hallucinated paths.)
2. **Direct commit landed.** At least one harness-driven code-class commit has shipped to `main` with sensors + reviewer + UAT 🟢. Backprop produced a §V invariant in the next commit.
3. **Garbage collection live.** GC cron has executed at least 3 nightly runs, surfaced at least one real drift case (frontmatter age, generator drift, broken link), and auto-merged at least one safe-class cleanup commit.
4. **Decision capture works.** A user-issued direction change in Discord produced a candidate ADR, was confirmed via reaction, and is now loaded in the always-injected ledger that future runs see.
5. **Honest-agent layer caught at least one fakery.** Either a stub-introduction was detected before push, OR an attestation cross-check failed and forced retry, OR a decision-assertion sensor blocked a contradicting diff.

If any fail, see Phase 13 (Rollback).

---

## 3. Existing canonical files (preserve, instrument with frontmatter)

Per `_research/STALENESS_INVENTORY.md` Top-5-canonical:

| File | Action |
|------|--------|
| `AGENTS.md` (128 lines) | Keep. Add `verified-at` frontmatter. Slim if drift discovered. Treat as TOC; never let it grow past ~150 lines. |
| `.claude/rules/*.md` (14 files) | Keep. Add `verified-at` frontmatter. |
| `CODEBASE_META_INDEX.md` | Move to `docs/checkpoints/` and mark as harness-regenerated; GC pass refreshes it. |
| `docs/design/brand/Brand Guidelines.md` (v3.0) | Keep. Add `verified-at`. |
| `JAMESON-PRIME.md` | Move to `docs/checkpoints/` with frontmatter. |

---

## 4. Wave-1 cleanup (Phase 12)

Per `_research/STALENESS_INVENTORY.md` Top-5 likely-to-mislead:

| File | Disposition |
|------|-------------|
| `docs/remediation/README.md` | Replace body with "remediation programs concluded; see ADR-NNNN." Subdirs already deleted. |
| `STATE.md` | Move to `.archive/2026-05-pre-harness/` (live state replaced by `harness/status` Discord command + `quality-grades.yaml`). |
| `docs/design/mobile-flows.md` | Move to `.archive/` (Swift app deleted in `a3e26be`). |
| `docs/design/mobile-deferred.md` | Move to `.archive/`. |
| `docs/decisions/project-history.md` | Move to `.archive/2026-05-pre-harness/`. |

These happen in **Phase 12** under harness GC pipeline (so the harness reviews itself, dogfooded).

---

## 5. Phases

### Phase 0 — `harness/` workspace bootstrap *(0.5 day)*

**Goal:** scaffold the workspace package as a peer of `core/`, `platform/`, `site/`, `phone-ai/`.

| Task | Outcome |
|------|---------|
| Create `harness/` directory at repo root | Workspace exists |
| Add to `pnpm-workspace.yaml` | pnpm recognizes it |
| `package.json` — Node 22+, TypeScript 5+, Fastify, discord.js v14, smart-whisper, chokidar, simple-git, pino, dotenv, zod, ws | Deps install |
| `tsconfig.json` extends root | TS clean |
| `.env.example` with secrets only: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_USER_IDS`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Joi-validated |
| `harness/README.md` — purpose, trust posture, off-limits | Self-documenting |

**Sensor:** `pnpm -F harness install && pnpm -F harness build` green.

### Phase 1 — `.harness/` filesystem scaffold *(0.5 day)*

**Goal:** create the filesystem layout per `FILESYSTEM_LAYOUT.md`.

| Task | Outcome |
|------|---------|
| `.harness/{config,ground,tasks,runs,inbox,transcripts,staleness}/` | Directories exist |
| `.gitignore` updates: `.harness/{runs,inbox,transcripts,staleness/log.jsonl}` ignored; rest committed | Two-zone separation seeded |
| `.archive/README.md` — "quarantine zone, hook-gated" | Future drop site |
| `.harness/config/workflow.md` — Symphony-shaped per-task prompt template | Policy committed |
| `.harness/config/sensors.yaml` — sensor registry | Discoverable |
| `.harness/config/stub-patterns.yaml` — initial ~30 patterns | Layer A seed |
| `.harness/ground/manifest.yaml` — empty stub; daemon will populate | Will fill on Phase 2 first run |

**Sensor:** `harness/scripts/check-layout.ts` validates directory structure matches spec.

### Phase 2 — Mirror checkout setup *(0.5 day)*

**Goal:** parallel git clone independent of user's working tree.

| Task | Outcome |
|------|---------|
| Script `harness/scripts/setup-mirror.ts`: detect repo origin, `git clone` to `~/.local/harness/repos/<project-name>/` | Mirror exists |
| Hook for `harness run` startup: `git fetch origin && git reset --hard origin/main` (only if no in-flight task) | Pin-to-HEAD on idle |
| Per-run pin: capture SHA at start; store in `.harness/runs/active/<id>/meta.json` | Snapshot pinning |
| Push policy: `git push origin main` after successful run | Direct-to-main |

**Sensor:** dry-run mirror operation produces a clean clone, can fetch, can reset, can push back (use a test branch first to avoid main pollution during bootstrap).

### Phase 3 — Grounding daemon *(2 days)*

**Goal:** `harness watch` long-lived process. Mostly mechanical.

| Component | Implementation |
|-----------|---------------|
| File watcher | `chokidar` on user's working tree + mirror, debounced 500ms |
| Hash registry | Walk canonical paths; sha256 each; write `.harness/ground/manifest.yaml` |
| Frontmatter parser | Read load-bearing markdown; extract `verified-at`, `status`, `source-commits`; surface stale via Discord |
| Schema extractor | When `core/src/drizzle/schema/` changes, regenerate `.harness/ground/schema/` markdown dumps |
| Routes extractor | When DTO/controller changes, regenerate `.harness/ground/routes/` from `core/openapi.json` |
| Events extractor | Walk `eventEmitter.emit(` calls + `EVENT_LABELS` map; produce `.harness/ground/events/registry.yaml` |
| Decisions ledger | Walk `.harness/ground/decisions/*.md`; produce compact `decisions.ledger.yaml` (always-loaded) |
| Quality grades calculator | Per-module: pass-rate of last N sensor runs + drift count; write `.harness/ground/quality-grades.yaml` |
| Drift detection | Hash of generated artifact vs current; if mismatched → drift event in `.harness/staleness/log.jsonl` |
| LLM use | **None in hot path.** Inferential drift summarization (e.g., "this doc no longer matches code") deferred to GC pass. |

**Sensor:** edit a schema file, daemon detects within 1s, regenerates ground/schema/ within 5s, manifest.yaml updated. Edit a doc's content; verified-at not updated → daemon flags within 30s.

### Phase 4 — `harness-mcp` server *(1 day)*

**Goal:** structured graph traversal + append-only writes; registered for Claude Code and Codex.

| Tool | Use |
|------|-----|
| `harness_decision_get(id)` | Returns full ADR + assertions block |
| `harness_decisions_in_scope(globs[])` | List decision IDs whose scope_globs overlap |
| `harness_decisions_for_symbol(file, symbol)` | Decisions binding a file+symbol |
| `harness_canonical_for_topic(topic)` | Path of canonical doc + sha + verified-at (no fuzzy match) |
| `harness_ground_get(category, key)` | Mechanical extract |
| `harness_supersedes_chain(decision_id)` | Forward chain |
| `harness_invariant_get(id)` | §V invariant + linked sensor |
| `harness_invariants_in_scope(globs[])` | List in-scope invariants |
| `harness_search(query, scope?)` | 3-layer: returns compact index (~50 tokens/result) |
| `harness_timeline(scope, window)` | Recent run/event timeline (windowed) |
| `harness_get_full(id, kind)` | Fetch full content by id (after search/timeline narrows) |
| `harness_query_history(scope, question)` | The ONLY way agents see `.archive/`; LLM-summarized result |
| `harness_append(path, content)` | Append-only write; path-allowlist gates; no read required |
| `harness_record_decision(id, title, summary, scope, supersedes?)` | Structured ADR write; UNIQUE id |
| `harness_record_run_event(run_id, event)` | Append to run event log |
| `harness_drop_task(title, body, intent)` | New task → `tasks/active/<id>/` |
| `harness_archive(path, reason)` | Quarantine a file |

Server registered in `.claude/settings.json` mcp block + `~/.codex/config`. Schemas validated with zod. See `MCP_SURFACE.md` for full schema and validation rules.

**Sensor:** integration test exercises every tool; assertions on output shape; rejection cases (missing id, path not in allowlist) produce structured errors.

### Phase 5 — Discord ingress (text + slash + buttons) *(1.5 days)*

**Goal:** discord.js bot accepts the operator surface defined in `WORKFLOW_GUIDE.md`.

| Surface | Form |
|---------|------|
| Slash | `/oops`, `/direction`, `/task`, `/status`, `/halt`, `/run`, `/ship-anyway`, `/eval`, `/agent` |
| Free text | Plain message → Tier-0 Ollama intent classifier → dispatch (or follow-up dialog) |
| Buttons | Components V2 — `[🟢 Approve & Push]`, `[🔴 Reject + tell me why]`, `[❓ Ask follow-up]` |
| Categories | `📋 backlog`, `🟢 active`, `📦 archive` — bot manages channel placement |
| Channel-per-task | New channel `task-<intent>-<short-id>` on task creation; moves between categories on lifecycle transitions; locked for writes on archive |

ACL: `DISCORD_OWNER_USER_IDS` allowlist. DM commands enabled (admin-only). All other guild members ignored.

**Sensor:** integration test creates a task channel via `/task`, verifies category placement; on `/halt` the channel moves to archive; locked-writes verified.

### Phase 6 — Whisper voice ingress *(1 day)*

**Goal:** voice notes auto-pickup → transcript → intent → dispatch.

Per `_research/DISCORD_WHISPER_DESIGN.md` design.

| Step | Implementation |
|------|---------------|
| Detect audio attachment | discord.js MessageCreate event; mime allowlist |
| Fetch buffer | `fetch(attachment.url)` → `Buffer` (no disk write) |
| Pipe through ffmpeg → 16k mono PCM | `child_process.spawn('ffmpeg', [...])` + node streams |
| `smart-whisper` (whisper.cpp Q5_0 large-v3-turbo) | Native addon, kept warm |
| Transcript | String + `avg_logprob` |
| Confidence guard | < 0.85 → bot replies "Heard: '...' — confirm?" with 🟢/🔴 |
| Route through same intent classifier as text | Symmetric pipeline |

**Sensor:** record a known voice note, send via Discord, assert transcript matches within Levenshtein 5; assert avg_logprob > 0.85 on clear speech.

### Phase 7 — Spec tightener (Layer F) *(0.5 day)*

**Goal:** Tier-1 LLM call before any code is written.

Per PRIMER §10 Layer F.

| Element | Detail |
|---------|--------|
| Model | Haiku 4.5 (Tier 1) for short specs; auto-escalate to Sonnet for >500 word bodies |
| Inputs | Task title + body + decisions ledger + ground extracts in scope + existing stubs/TODOs |
| Output | Structured JSON: `{ ambiguities, conflicts, missing_acceptance, scope_concerns, existing_stub_overlap, spec_quality_score, ready_to_execute, tightened_spec_proposal }` |
| Threshold | `quality_score >= 7 AND ready_to_execute` → proceed |
| Below threshold | Discord post with A/B/C/D options for each ambiguity; user answers; re-run with answers folded in |
| Override | `/ship-anyway` — persists tightener output as advisory; proceeds without resolving |

**Sensor:** synthetic vague task (`"fix the integration thing"`) produces ≥3 ambiguities + low quality score. Synthetic clear task (`"add unique partial index on integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL"`) produces 0 ambiguities + score 9+.

### Phase 8 — Orchestrator + agent runner *(2 days)*

**Goal:** the FIFO scheduler and the agent-spawning subprocess.

| Component | Implementation |
|-----------|---------------|
| Task queue | In-memory FIFO; persisted shadow at `.harness/tasks/active/_queue.yaml` |
| Concurrency | Hard cap = 1 |
| Workspace prep | Mirror reset hard to `origin/main`; capture SHA in run meta |
| **`local_dirty_overlap` gate (per Codex audit Q3, must-fix)** | Before dispatch AND before push, daemon checks: are any files in user's working tree currently dirty (un-pushed local edits) that overlap the run's `target_path_globs`? If yes → pause run, post Discord/adapter dialog: "your local edits in `<file>` overlap this run's scope. A) Stash and proceed B) Cancel run C) Wait until clean (re-check in N min)". Avoids the worst race: harness ships a change to a file user is also editing locally → user's later pull conflicts → user resolves manually, bypassing sensors. |
| Prompt rendering | Liquid-style template engine on `.harness/config/workflow.md` body; inject decisions ledger + invariants ledger + scope-relevant ground extracts |
| Agent launch | `spawn('claude', ['--print', '--output-format', 'json'], { cwd: mirrorPath, stdin: renderedPrompt })` |
| Event streaming | Parse JSON output stream; write events to `.harness/runs/active/<id>/events.jsonl` |
| Status surface | Discord thread updates per phase transition; `/status` returns running task summary |
| Reconciliation | Per-tick: stall detection (no event in 5 min → kill + retry), tracker state refresh (task still active in tasks/active/?) |
| Retry | Continuation: 1s. Failure: `min(10s * 2^(attempt-1), 5m)` per Symphony §8.4 |

**Sensor:** dry-run with hard-coded task (`"create file harness/scratch/echo.txt with HELLO"`); verify mirror modified, file exists, run row reflects `succeeded`, no commit yet (waiting on UAT or auto-merge gate).

### Phase 9 — Sensor runners + Layer A/B/D + decision-assertions *(1.5 days)*

**Goal:** wire computational sensors per PRIMER §6 + honest-agent layers A/B/D + decision-assertions.

| Sensor | Trigger |
|--------|---------|
| `lint` (per affected workspace) | every run |
| `tsc --noEmit` (per workspace) | every run |
| `openapi-no-drift` | run touches `*.dto.ts` or `*.controller.ts` |
| `schema-drift` | run touches `core/src/drizzle/schema/` |
| `event-labels-coverage` | run touches `eventEmitter.emit(` |
| `stub-allowlist-purity` | run touches `SHARED_CORE_ACTION_KINDS` |
| `pii-fixture` | run touches `core/src/pii/` |
| `frontmatter-freshness` | nightly cron |
| `Layer A: stub-pattern catalog` | every run; matches `.harness/config/stub-patterns.yaml` |
| `Layer B: attestation cross-check` | every run completion |
| `Layer D: route-handler-non-empty` + `dto-no-fake-fields` | every run |
| `decision-assertions` | every run; iterate decisions in scope; evaluate machine-readable assertions; fail with quoted assertion |

Each sensor's failure message is a remediation prompt — the failing sensor's output is fed back as new context to the agent for retry. Per OpenAI's pattern: *"the lints are custom, they write the error messages to inject remediation instructions into agent context."*

**Sensor:** synthetic failing case for each sensor produces a clean structured fail report in Discord thread; retry consumes the failure as context.

### Phase 10 — Reviewer subagent (Layer C) *(0.5 day)*

**Goal:** fresh-context reviewer that reads only diff + spec + decisions.

| Detail | |
|--------|---|
| Model | Same as implementer (no model split) |
| Context | spec.tightened.md + diff + decisions.ledger + in-scope assertions |
| Excluded | Implementer's reasoning, prior turns, agent's tool-use trace |
| Prompt framing | Anti-completionist; default-fail; "prove me wrong" |
| Output | Structured `{ verdict: pass|fail, gaps: [...], confidence_signal: ... }` |

**Sensor:** synthetic diff with deferred-but-claimed-done function produces `verdict: fail` + `gaps` enumerates the deferral.

### Phase 11 — UAT-on-phone (Layer U) *(1.5 days)*

**Goal:** headless Chrome UAT → GIF → Discord button → push (no PR).

Per `UAT_PIPELINE.md`.

| Step | |
|------|---|
| UAT-runner agent (Tier 2) | Reads spec.tightened.md, generates Playwright script targeting the change |
| Headless Chrome run | Via `mcp__claude-in-chrome` or local Playwright; capture GIF + screenshots + console + network |
| Backend-only path | curl/SQL transcript; or trace replay; or sensor-output table |
| Evidence file | `.harness/runs/active/<id>/uat/.uat-passed` contains SHA256 of the artifact bundle |
| Pre-push gate | Refuses to commit unless evidence file exists AND its SHA256 matches the recomputed bundle hash |
| Discord post | GIF embedded; pass/fail summary; `[🟢 Approve & Push]`, `[🔴 Reject]`, `[❓ Ask]` buttons |
| Persistent UAT.md | `.harness/tasks/<id>/uat.md` carries `status` and `blocked_by` separate from Gaps |

**Sensor:** synthetic UAT failure produces 🔴-able artifact set; bare `touch` of `.uat-passed` rejected (SHA mismatch).

### Phase 12 — Garbage collection cadence *(1 day)*

**Goal:** OpenAI-style background drift sweep.

| Pass | Cadence | Action |
|------|---------|--------|
| Frontmatter freshness | nightly 3am Phoenix | Surface stale list to Discord; Option-A safe-class auto-PR refresh-of-frontmatter via verified mechanical regen |
| Generator drift | nightly | Auto-regenerate; commit `chore(gc): regenerate <artifact>` if no source change required |
| Stub catalog hits | nightly | Open targeted refactor commits for safe-class; surface unsafe-class for confirm |
| Doc-gardening | nightly | Detect dead links, orphan paths; propose moves to `.archive/` |
| Quality-grade update | nightly | Recompute per-module score from sensor pass-rate; write `quality-grades.yaml` |
| **Batch canary (per Codex audit, must-fix)** | every GC pass with >1 commit | Before pushing the batch, render the WORKFLOW.md template against a synthetic-task fixture and assert it produces a syntactically-valid prompt; assert that running every relevant sensor against the post-batch `main` snapshot still passes (no commit individually broke things, but their combination might); if either fails → abort batch, surface to operator, no auto-merge. |
| Wave-1 cleanup pass (one-time) | manual `/run wave-1` | Apply Section 4 above using harness pipeline (dogfooded) |

Auto-merge classes per PRIMER §12.2:

| Class | Push policy |
|-------|-------------|
| Safe | sensors → push, no UAT |
| Code | sensors + reviewer + UAT 🟢 → push |
| High-stakes | above + E2E real-DB + Layer E demo → push |

**Sensor:** synthetic stale frontmatter case; GC pass surfaces it; safe-class auto-merge produces clean commit on main visible in user's working-tree pull.

### Phase 13 — Backprop protocol *(0.5 day)*

**Goal:** every code-class fix produces §V invariant + sensor.

Per PRIMER §13.

| Step | |
|------|---|
| After fix lands | Backprop subagent runs |
| Reads | spec.tightened.md, the diff, the failure that motivated the fix |
| Outputs | §V invariant entry to `.harness/ground/invariants/V<N>.md` |
| Generates | Sensor script `harness/scripts/check-v<N>-<slug>.ts` OR named E2E case `e2e/V<N>_<slug>.spec.ts` |
| Commits | `chore(invariants): add §V<N> from run #<id>` |
| Naming convention | sensor + test cite invariant ID; commit messages reference; `manifest.yaml` indexes |

**Sensor:** complete a synthetic fix; backprop produces an invariant file + sensor script; sensor script invoked on a future synthetic regression detects the regression.

### Phase 14 — Decision capture flow *(0.5 day)*

**Goal:** Discord-issued direction changes survive as binding facts.

| Step | |
|------|---|
| User in Discord: `/direction <text>` OR plain message detected as direction | Tier-0 classifier flags |
| Decision-extractor (Tier 1) | Structured output: `{ subject, scope_globs, supersedes?, summary, candidate_assertions }` |
| Drop draft | `.harness/ground/decisions/_inbox/<DEC-id>.draft.md` |
| Discord prompt | "Confirm DEC-NNNN? [🟢 commit] [🟡 edit] [🔴 not a decision]" |
| At confirm | Move draft → `.harness/ground/decisions/<DEC-id>.md`; daemon regenerates `decisions.ledger.yaml`; assertions become live |
| At edit | Open thread; user provides corrections; re-run extractor |
| At reject | Discard; no record |

**Sensor:** synthetic Discord message ("scrap that, FK denorm only") produces draft within 30s; confirm → ledger reflects within 5s; next run loads new entry in always-injected ledger.

### Phase 15 — Trial-run pilot *(2 days)*

**Goal:** prove end-to-end on a real task **anywhere in mypal** (per operator answer A2 — full repo, not just integrations module). The pilot module list is the entire repo at adoption time, with `high_stakes_globs` triggering Layer E + cross-tenant fixture for the more sensitive modules.

| Step | |
|------|---|
| Pilot task | A real backlog item: e.g., "add unique partial index on `integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL`" |
| Submission | `/task` slash + dialog OR voice note |
| Watch full lifecycle | spec tightener → mirror prep → agent run → sensors → reviewer → UAT-on-phone → 🟢 → push to main → backprop |
| Voice variant | Same task as voice note → assert transcription, intent class, full pipeline |
| Decision-capture variant | "actually, also add the symmetric index for archived_at IS NOT NULL" via Discord → confirm → next run sees it |

**Sensor:** all five trial-run acceptance criteria in §2 satisfied within timebox.

### Phase 16 — Init / portability bootstrap *(1.5 days)*

**Goal:** `npx @devplusllc/harness init <repo-dir>` lifts cleanly to any project.

#### 16.1 Stack profiles (per Codex audit Q8, must-fix)

The init script does NOT assume TypeScript+pnpm+Drizzle+OpenAPI+Claude-Code-hooks. It detects and selects a profile:

| Profile | Stack signature | Generic sensors | Project-specific sensors proposed | Hook strategy |
|---------|----------------|----------------|-----------------------------------|---------------|
| `typescript-next-nest` | `package.json` with `next` or `@nestjs/*`; `pnpm-lock.yaml` or `package-lock.json` | tsc, eslint | openapi-drift (if NestJS+Swagger), schema-drift (if Drizzle), event-coverage (if `eventEmitter.emit`) | `.claude/settings.json` hooks if Claude Code detected; CLI-only otherwise |
| `python-fastapi` | `pyproject.toml` or `requirements.txt`; `fastapi` import | ruff, mypy, pytest-collect (without running) | alembic-migration-drift, openapi-drift via `app.openapi()` | git pre-commit hook if no Claude Code |
| `python-django` | `manage.py` + `INSTALLED_APPS` | ruff, mypy, django-checks | migration-drift, urls-coverage | same |
| `rails` | `Gemfile` with `rails` | rubocop, brakeman | active-record-migration-drift, routes-coverage | git pre-commit hook |
| `go` | `go.mod` | go vet, staticcheck, gofmt | sqlc-drift (if sqlc present), proto-drift (if buf present) | git pre-commit hook |
| `rust` | `Cargo.toml` | cargo clippy, cargo check | sqlx-prepare-drift | git pre-commit hook |
| `unknown` | none of the above | none | none | hook-less; sensors via `harness <stage>` CLI |

Each profile owns:

- Sensor list (mechanical commands)
- Start command for `pnpm dev` equivalent
- Generated artifact identification (for drift detection)
- Hook capability (Claude Code hooks vs git hooks vs CLI-only)
- Off-limits-path defaults
- High-stakes-glob defaults (heuristic; operator confirms)

Profile lives in `harness/src/profiles/<profile>/`; users can author custom profiles in `.harness/config/profile.yaml`. All harness code reads from the profile abstraction — never hardcodes a tech-stack assumption.

#### 16.2 Init pipeline

The init script is **inquirer-driven** end-to-end (per operator instruction 2026-05-02). All operator-facing questions during `npx @devplusllc/harness init` use `inquirer` prompts with sensible defaults pre-filled from auto-detection. The squares-into-square-holes UX rule (`docs/WORKFLOW_GUIDE.md` §1) applies: every question is `list` / `confirm` / `checkbox` first, with `input` only as the typed-default fallback. `E) Other` escape on every multi-choice question.

The init script lives at `harness/src/init/`. Add `inquirer` (^9 or current) to `harness/package.json` deps when Phase 16 starts. Follow the same export pattern as `harness/src/cli/run.ts` for sub-command dispatch.

| Step | inquirer prompt(s) |
|------|---|
| Detect stack profile | Auto-detect from project root; show detected profile in `confirm` prompt with `list` of all profiles as fallback. Default = detected; `E) Other` opens `input` to declare a custom profile name. |
| Mapper agent (Tier 2, LLM-heavy, one-time) | After profile confirmed: dispatched without prompts. Walks repo using profile's canonical-path rules; inventories canonical paths; proposes pilot module; proposes sensor list (profile + project-specific); proposes off-limits paths; proposes initial `WORKFLOW.md` body. **Project-agnostic prompt — never hardcode the project's name or domain into harness pkg code; mapper proposes a `<project-name>:` extension block keyed by the project's own `package.json name` or directory name.** (per operator answer S1) Output is shown to operator as a `confirm`/`edit` prompt before write. |
| Mechanical extract pass | No prompts. Generates initial `.harness/ground/manifest.yaml` from current file hashes; profile-specific generators (Drizzle dump, OpenAPI dump, alembic, etc.) |
| Scaffold | No prompts. `.harness/{config,ground,tasks/active,runs,inbox,transcripts,staleness}/`, `.gitignore` updates, `.archive/` empty + README |
| Hook installation | `list` per profile: Claude Code hooks if available; git pre-commit/pre-push hooks otherwise; CLI-only if user opts out |
| Ollama check | Detect via `which ollama`; if missing, `list` (per operator answer M2 = yes auto-install): A) Install + pull required models, B) Skip (Tier 0 falls back to Tier 1, ~$5-10/day extra), C) Re-check (I'll install in another terminal) |
| Frontend adapter bootstrap | `checkbox` of registered adapter slugs (`discord` / `notion` / `cli` / `web`). Per checked adapter, additional inquirer prompts: Discord (`input` guild ID + masked `password` bot token + comma-separated owner IDs); Notion (`input` DB target id via Notion MCP); CLI (no setup). All collected secrets write to the adopting project's `.env` (gitignored), not committed config. |
| `harness/` workspace | No prompts. Install harness pkg as devDep (npm/pip/cargo/etc. depending on profile); copy starter scripts |
| Readiness report | No prompts. What's ready, what needs operator decision, what's deferred. Final `confirm` prompt: "ready to run `harness watch` + `harness run`?" |

#### 16.3 Distribution mechanism (per operator answer M1)

The harness pkg needs to be shareable with friends as testers before npm publish.

| Mechanism | Use |
|-----------|-----|
| Private GitHub repo + `npm install <git-url>` | Default. Friends granted read access; install via `npm install github:devplusllc/harness#<sha>` |
| Tarball (`pnpm pack`) | When friend can't use npm git installs; produces `devplusllc-harness-<version>.tgz` |
| Direct repo clone + symlink | For collaborative debugging — clone repo, `npm link`, point adopting project at the link |
| npm publish (later) | Once we have a stable v0; published as `@devplusllc/harness` |

Init script supports all: `npx @devplusllc/harness init` works with the npm name, `npx github:devplusllc/harness init` works with the git URL, `npx /path/to/local/harness init` works with the local clone.

**Sensor:** run `npx @devplusllc/harness init` on a fresh dummy repo; verify all directories present, all scaffolded files have provenance frontmatter, and a `harness watch` + `harness run` start cleanly.

### Phase 17 — Operator UX polish + WORKFLOW_GUIDE finalization *(0.5 day)*

| Task | |
|------|---|
| Bot reply formatter — terse tables, run-id footer, cost line | per WORKFLOW_GUIDE §replies |
| `/status` returns running task, queue depth, recent runs, eval summary, weakest module | default Discord call surface |
| `/halt` SIGTERM + 30s grace + SIGKILL; orphan-process scan on harness restart | Cancellation primitive |
| `/oops` dialog complete | per WORKFLOW_GUIDE dialogues |
| `/direction` decision-capture loop | per Phase 14 |

### Phase 18 — Rollback (only if trial fails)

| Action | Cost |
|--------|------|
| Stop both `harness watch` and `harness run` | Zero |
| Disable Discord bot | Zero |
| Move `harness/` workspace + `.harness/` content to `.archive/2026-05-harness-pilot/` | Information preserved |
| Push that archive commit | Repo unaffected by rollback |
| Keep `WORKFLOW.md`, `decisions/*`, `invariants/*` for next attempt | Never lose decisions |

---

## 6. Cross-cutting concerns

### 6.1 Authentication / secrets

| Class | What | Where |
|-------|------|-------|
| Secrets | `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_OWNER_USER_IDS`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_HOST` (default `http://localhost:11434`) | `.env`; Joi-required |
| Non-secret config | sensor list, off-limits paths, trust posture, polling intervals, pilot module, model tier per task class | `.harness/config/workflow.md` and `.harness/config/sensors.yaml` |

Honors AGENTS.md: only secrets/brand/domain in env.

### 6.2 Observability

- Pino logs to `.harness/runs/<id>/log.jsonl`
- Discord thread per run (operator-visible)
- `/status` slash for at-a-glance
- `quality-grades.yaml` for module-health surface
- `.harness/staleness/log.jsonl` for drift events

### 6.3 Concurrency + idempotency

- Hard cap 1 concurrent code-class run; queue for the rest
- Per-task idempotency: dedupe via `(channel_id, message_id)` on Discord ingress
- Mirror is the only writable git state for the harness
- Snapshot pinning: every run captures origin/main SHA at start; reads/diffs against that SHA only
- Background processes (daemon, GC) operate only on committed state when no run active

### 6.4 Failure modes the harness must handle gracefully

| Failure | Response |
|---------|----------|
| Whisper subprocess crash | Re-init lazily; 3 consecutive fails → page operator + disable voice ingress |
| Discord API rate-limit | discord.js built-in queue; back off without dropping intents |
| Claude API rate-limit | BullMQ-style delay re-enqueue with exponential backoff |
| Sensor produces unexpected output | Log raw + stop run as `failed-sensor-parse`; do not silently pass |
| Mirror diverges from origin/main | Operator paged; manual `harness mirror reset` to recover |
| User pushed to origin during in-flight run | Run completes against pinned SHA; next task picks up new HEAD |
| Spec tightener returns malformed JSON | Retry once with stricter prompt; second fail → flag task as `tightener-failed`, surface to operator |
| `.uat-passed` SHA mismatch | Hard reject push; surface to operator |
| Backprop fails to author invariant | Run still merges; backprop retried as separate task; operator surfaced |
| Hooks deny agent's write | Sensor failure with `blocked_by_hook` reason; agent retry with rejection context |
| Decision contradicts in-flight diff | Run re-prompts agent with the conflicting decision id + assertion text |

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `WORKFLOW.md` template rendering bugs cause silent prompt corruption | Med | Strict template engine; render-time test on every config change |
| Subagents bypass off-limits | Med | Subagent definitions re-state off-limits; PreToolUse hook blocks writes outside mirror |
| Discord outage | Low | CLI fallback always available |
| Whisper transcription errors cause wrong dispatch | Med | Confidence guard + 🟢/🔴 confirm below threshold |
| Sensor false negative — agent ships a real bug | High | Reviewer subagent + UAT layer + decision-assertions; backprop turns each into a permanent §V invariant |
| Sensor false positive — blocks valid commit | Med | Operator override via `/ship-anyway`; failure-rate per-sensor tracked; auto-disable past threshold |
| GC auto-merges a regression | Med | Safe-class is narrowly scoped (formatting / regen / archive); revert is a single git command |
| Mirror checkout grows large | Low | Periodic `git gc` in mirror; not the user's concern |
| Stale-doc purge accidentally archives a load-bearing file | Med | Wave-1 deletions go through harness pipeline; reviewer + operator approval; archive is recoverable |
| `/halt` doesn't reach a stuck subprocess | Med | OS-level SIGTERM + 30s grace + SIGKILL; orphan-process scan on harness restart |
| Symphony SPEC v2 incompatible | Low | We implement load-bearing parts only; spec drift is doc update, not rewrite |
| Decision ledger grows unbounded | Low | Superseded decisions remain (history) but don't load into ledger summary; only `status: accepted AND superseded_by IS NULL` |
| Ollama unavailable on operator's mac | Low | Falls back to Tier-1 (Haiku) on intent classification; operator paged once |

---

## 8. Definition of done — full system *(beyond trial)*

The harness ships from pilot to general use when:

- All `core/src/*` modules can be referenced as `WORKFLOW.md mypal.pilot_module` candidates
- Reviewer subagent has caught ≥1 cross-tenant bug in a real diff
- Backprop has produced ≥5 §V invariants from real fixes
- Garbage collection has produced ≥10 self-merged safe-class commits
- Decision capture has produced ≥3 confirmed ADRs from Discord
- Staleness inventory at `_research/STALENESS_INVENTORY.md` shows ≥80% reduction
- Trial-run criteria sustained over 4 weeks
- Cost stays within the operator's Claude Code coding-plan subscription quota — that is the only metric that matters (per operator answer T1; raw $/day budget dropped). Rate-limit + budget-exhaustion events from Anthropic API surface as harness self-disable + page operator via active frontend adapter.
- `npx @devplusllc/harness init` runs cleanly on at least one other project (you pick a sample side project)
- Codex peer-review pass folded in (per `docs/CODEX_REVIEW_BRIEF_REVIEW.md`); all `must-fix-before-build` findings closed; `should-revisit-soon` findings tracked or closed.

---

## 9. Implementation order summary

```
Day 0.5:  Phase 0   — workspace bootstrap
Day 1:    Phase 1   — .harness/ scaffold
Day 1.5:  Phase 2   — mirror checkout
Day 3.5:  Phase 3   — grounding daemon
Day 4.5:  Phase 4   — harness-mcp server
Day 6:    Phase 5   — Discord ingress
Day 7:    Phase 6   — Whisper ingress
Day 7.5:  Phase 7   — spec tightener
Day 9.5:  Phase 8   — orchestrator + agent runner
Day 11:   Phase 9   — sensor runners + Layer A/B/D
Day 11.5: Phase 10  — reviewer subagent (Layer C)
Day 13:   Phase 11  — UAT-on-phone (Layer U)
Day 14:   Phase 12  — GC cadence (includes Wave-1 cleanup)
Day 14.5: Phase 13  — backprop protocol
Day 15:   Phase 14  — decision capture
Day 17:   Phase 15  — trial-run pilot
Day 18.5: Phase 16  — init / portability bootstrap
Day 19:   Phase 17  — UX polish
─────────
~19 founder-days sequential. With harness self-acceleration on later phases (the harness builds itself partway through), realistic ~12-14 founder-days.
```

---

## 10. Pointer to the rest of the doc set

- `PRIMER.md` — concepts and principles
- `FILESYSTEM_LAYOUT.md` — concrete layout under `.harness/`
- `MCP_SURFACE.md` — full MCP tool schemas + validation
- `UAT_PIPELINE.md` — UAT-on-phone flow + evidence-file gate
- `WORKFLOW_GUIDE.md` — operator UX rules + tier ladder + slash dialogues
- `QUESTIONS.md` — residual open items (most defaults locked)
- `_research/STALENESS_INVENTORY.md` — drives Phase 12 Wave-1 cleanup
- `_research/DISCORD_WHISPER_DESIGN.md` — drives Phases 5 + 6 + UAT_PIPELINE
