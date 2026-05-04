---
type: spec
status: draft-v1
audience: dual
generated: 2026-05-03
depends-on:
  - docs/PRIMER.md (§8.4)
  - docs/SESSIONSTART_SPEC.md
  - docs/DAEMON_SPEC.md
  - docs/FILESYSTEM_LAYOUT.md (run artifacts)
---

# Harness — Context Continuity Spec

Claude Code's context window fills. `/compact` summarizes and loses nuance. Long-running tasks span multiple sessions. This spec defines how the harness ensures a run survives context limits without losing any meaningful state.

**The core principle: git is the memory.** Nothing that matters should exist only in the context window. Phased commits create an auditable, exact record that any session can reconstruct from. The harness doesn't need a separate memory system — it reads the git history.

---

## 1. The problem

A task takes 3 hours and touches 40 files. At hour 2, the context window is 85% full. Claude Code compacts. The summary is lossy — the nuanced reasoning about why `approach-A` was abandoned in favor of `approach-B`, the discovered constraint in the third-party API, the partially-done phase-3 — all of this becomes a vague paragraph.

The next session starts cold. The agent reads the tightened spec (which doesn't mention `approach-A` was tried), reads the current file state (which is mid-refactor), and makes decisions that undo 30 minutes of careful work.

---

## 2. The solution: phased commits + git-as-memory

### 2.1 Phased commits

The spec-planner, when chunking a task into sub-tasks, annotates `spec.tightened.md` with named checkpoints:

```yaml
# spec.tightened.md frontmatter
checkpoints:
  - id: phase-1
    label: "auth schema migration"
    globs: ["src/db/schema/auth.ts", "src/db/migrations/**"]
  - id: phase-2
    label: "route handlers"
    globs: ["src/routes/auth/**"]
  - id: phase-3
    label: "frontend integration"
    globs: ["src/components/auth/**"]
```

The agent is instructed (via the tightened spec) to commit at each checkpoint boundary. These intermediate commits go to the mirror's main branch with message `wip(TSK-<id>): <phase-label>`. They are real commits, not stashes. The diff is real. The git history is real.

For small tasks with no chunking, there are no intermediate checkpoints — just the final commit.

### 2.2 Session handoff from git history

When SessionStart detects an active run in `tasks/active/<id>/` with `phase: running`, it generates a **run handoff block** from the git history instead of relying on the context window:

```
harness hook session-start
  → detects active run TSK-<id>
  → reads git log <sha-pin>..HEAD (commits since run start)
  → reads git diff HEAD -- <touched-files>
  → reads spec.tightened.md checkpoints (which are done vs remaining)
  → generates handoff block
```

The handoff block is injected **first** in the SessionStart payload — before decisions, before invariants, before everything else. It is the most important context for a resuming session.

**Handoff block format:**

```
## ⟳ Resuming run TSK-<id> — <task-title>

Commits since run start (mirror):
  a3f9c12  wip(TSK-<id>): auth schema migration
  b7e2d45  wip(TSK-<id>): route handlers

Phases complete: phase-1 (auth schema), phase-2 (route handlers)
Phases remaining: phase-3 (frontend integration), phase-4 (tests)

Files touched so far: 12 files (git diff summary)
  src/db/schema/auth.ts         [+47 -12]
  src/routes/auth/login.ts      [+89 -0]
  src/routes/auth/logout.ts     [+34 -0]
  ... (8 more)

Agent notes from previous phases:
  phase-2: discovered that /auth/refresh does not return a new CSRF token —
  the frontend needs to re-fetch it separately. Not in the original spec.
  phase-2: approach-A (session cookies) abandoned — CSP headers conflict.
  Using JWT in httpOnly cookie per DEC-0019.
```

The agent reads this and knows exactly where it is without reading a single source file. The git history is the ground truth.

### 2.3 Agent notes

During execution, the agent can write notes to `.harness/tasks/active/<id>/notes.md` using `harness_append_run_note`. These are free-text observations — discovered constraints, tried-and-rejected approaches, gotchas — that don't rise to the level of a formal decision but matter for continuity.

The handoff block includes notes from previous phases (see format above). Notes accumulate across phases and are never truncated.

`harness_append_run_note` is an MCP write tool — append-only, no prior read required. Cost: ~5 tokens to call.

---

## 3. Context monitoring

The daemon monitors `ctx_tokens_used` in `status.json` (written by the SessionStart hook after each injection). The status line shows `ctx:N/M` at all times.

| Threshold | Action |
|-----------|--------|
| < 60% | Normal operation |
| 60–75% | Status line shows `ctx:N/M` dimmed — visible but no alert |
| 75% | Status line shows `task:running(ctx:warn)` — daemon writes a checkpoint snapshot |
| 90% | Daemon flags `attention:1` — operator may want to trigger `/compact` or let the run complete |

**Checkpoint snapshot** (written at 75%): daemon reads `git log + git diff` and writes `.harness/tasks/active/<id>/checkpoint-<timestamp>.md`. This is the same content that would become the handoff block if the session ends here. If the run completes normally, the checkpoint is ignored. If the session ends mid-run, the checkpoint is the recovery artifact.

The daemon does not force a compact or kill the session. The agent keeps working. The checkpoint is a safety net, not a disruption.

---

## 4. Session resume detection

The SessionStart hook receives `source: "resume" | "startup" | "clear" | "compact"`.

| Source | Handoff behavior |
|--------|-----------------|
| `startup` | Check for active run. If found, inject handoff block. |
| `resume` | Always inject handoff block if active run exists — `/resume` was likely triggered because context filled. |
| `compact` | Inject full handoff block — post-compact session has lost context. This is the primary recovery path. |
| `clear` | Inject handoff block — `/clear` resets context. |

For `startup` with no active run: no handoff block, normal SessionStart payload.

---

## 5. What happens when context truly fills (no operator action)

If the agent's context fills completely and Claude Code triggers an automatic compact:

1. Post-compact `SessionStart` fires with `source: "compact"`
2. Handoff block is generated from git history + notes
3. Agent resumes with full knowledge of where it was
4. No work is lost (it's in git)
5. No operator action required

This is the default path. The operator doesn't need to manage context — the harness handles it.

---

## 6. Continuity for the full pipeline (not just the agent turn)

Context continuity applies to all harness processes, not just the agent:

| Process | Continuity mechanism |
|---------|---------------------|
| Agent (implementer) | Phased commits + git handoff |
| Spec tightener | `spec.tightened.md` persisted in run dir before agent starts |
| Sensor sweep | `sensor-results.yaml` written per run — if sweep is interrupted, re-run picks up from first failed sensor |
| Reviewer subagent | Reads diff + spec from disk — stateless, always restartable |
| Backprop subagent | Reads diff + failure from disk — stateless, always restartable |
| UAT runner | Evidence file gate — if `.uat-passed` exists with correct SHA, UAT is already done |

Every process is restartable from its on-disk inputs. No process depends on in-memory state that can't be reconstructed from the run dir.

---

## 7. Anti-patterns

| Anti-pattern | Why rejected |
|---|---|
| **Relying on `/compact` summary for continuity** | The LLM-generated compact summary is lossy. Git diff + notes is exact. Use git. |
| **One giant commit at the end** | If context fills mid-run, there's nothing to reconstruct from. Phased commits are the insurance policy. |
| **Handoff file separate from git** | Creates two sources of truth. Git *is* the handoff. |
| **Forcing compact at a threshold** | Interrupts the agent mid-thought. The 75% checkpoint writes a snapshot; the agent keeps going. Compact only happens when Claude Code decides to, not when the harness forces it. |
| **Agent memory via special memory files** | Anything not in git can't be reconstructed. `notes.md` is appended via MCP and committed to the run dir. It's in the repo. |
| **Checkpoints as separate task files** | Checkpoints are annotations in `spec.tightened.md`, not new files. The spec is the single source of task structure. |

---

## 8. Implementation

```
harness-core/src/
├── context/
│   ├── monitor.ts          — reads status.json, writes checkpoint at threshold
│   ├── handoff-builder.ts  — generates handoff block from git log + diff + notes
│   └── checkpoint.ts       — writes checkpoint-<ts>.md to run dir
└── mcp/tools/
    └── append-run-note.ts  — harness_append_run_note MCP tool
```

`handoff-builder.ts` is called by the SessionStart hook when an active run is detected. It calls `git log` and `git diff` via child_process (not via MCP) — these are local git operations, sub-50ms.

The handoff block is prepended to the SessionStart `additionalContext` before all other sections. Token budget for the handoff block: up to 600 tokens (roughly 3-4 phases of notes + file summary). If the git log is very long (>20 commits), truncate to the 20 most recent with a trailing note.

---

## 9. Relationship to SESSIONSTART_SPEC.md

SESSIONSTART_SPEC.md §4 defines the current task injection (Section 4 — `current_task`). Context continuity extends this:

- Section 4 (current task) → injected if task is `queued` or `tightening` (no commits yet)
- **Handoff block** → replaces/extends Section 4 when task is `running` or `sensing` and commits exist since `sha_pin`

The handoff block is Section 0 (highest priority) — injected before the two-zone reminder, before decisions, before everything. A resuming agent needs to know where it is before it knows what rules apply.

SESSIONSTART_SPEC.md should be updated to document Section 0 when `source` is `resume|compact` and an active run exists.

---

## 10. Spec delta injection at run start

When a run starts, before the spec tightener (Layer F) fires, the harness computes a **spec delta**: what changed in ground state since the affected code was last touched. The tightener receives this delta as a fourth input alongside task body, in-scope decisions, and in-scope invariants (per `PRIMER.md` §5 Layer F + `DOCS_SPEC.md` §4).

### 10.1 Why

Without the delta, the tightener sees the current ground state but has no signal that the code it's about to modify was authored 3 weeks ago under different rules. §V0041 was superseded by §V0052; DEC-0089 was added — the agent discovers these through sensor failures instead of upfront. Half a run wasted, then a remediation pass.

The delta surfaces the change before any code is written. The agent decides: continue with the new rules, or pause for an operator clarification.

### 10.2 Computation

Three steps. All mechanical, no LLM.

1. **Resolve task scope to file paths.** From `task.target_path_globs` (or scope-index reverse lookup if `target_path_globs` is empty), compute the concrete set of files the task is most likely to touch. Cap at 100 paths to keep `git log` cheap.
2. **Find last-touch SHA per file.** `git log --max-count=1 --format=%H -- <path>` for each path. Take the MIN (oldest) of the resulting SHAs as the delta cutoff: that's the SHA after which any ledger change is news to all the files in scope.
3. **Diff the ledgers.** Read `.harness/ground/decisions/decisions.ledger.yaml` and `.harness/ground/invariants/invariants.ledger.yaml` at both `<cutoff>:<path>` and HEAD. Diff:
   - Decisions added since cutoff whose `scope_globs` overlap any task-scope path.
   - Decisions whose `status` changed from `accepted` to `superseded` since cutoff (and whose scope overlaps).
   - Invariants added since cutoff whose `source_decision`'s scope overlaps.
   - Invariants whose `status` changed from `active` to `superseded_by: V<M>` since cutoff.
   - Brand/product/positioning files modified since cutoff (file-level, not entry-level — these aren't ledgered).

### 10.3 Output format

```
Ground state delta since src/auth/ was last touched (abc1234, 21 days ago):

Decisions:
  + DEC-0089 — actor_user_id denormalization (scope: src/auth/**)
  ~ DEC-0042 — superseded by DEC-0091

Invariants:
  + §V0052 — bearer tokens must expire in ≤24h (source: DEC-0089)
  ~ §V0041 — superseded by §V0052

Brand:
  brand/voice.md modified 12 days ago
```

When the delta is empty (no in-scope changes since cutoff): no injection, no overhead. The tightener proceeds with the standard inputs.

### 10.4 When it fires

- **Run start, after spec → spec.tightened pre-pass, before the Tier-1 tightener LLM call.**
- **NOT on resume / compact** — those use the run handoff (§2). The handoff already covers "what was happening in this run"; spec delta covers "what changed in ground state vs the code's last edit."
- **Skipped for code-class runs whose first commit is itself the cutoff** — no prior history means no delta.

### 10.5 Tightener integration

The tightener receives the delta as a fourth named input. Its system prompt (in `tightener/prompt.ts`) is amended to surface non-empty deltas as the FIRST item in its output:

```
### Output (when delta non-empty)
1. **Spec delta** — these rules changed since the in-scope code was last touched.
   Read each before proceeding. If any contradicts the task body, surface as
   the only ambiguity and ask. The operator can answer with a /direction or
   confirm the new rules apply.
2. (rest of standard tightener output)
```

When delta is empty: identical to the current tightener output structure.

### 10.6 Cost

Two `git log` invocations (one for path resolution, one per file for last-touch — bounded at 100 files), one `git show` per ledger, one local diff. Total: < 200ms on a typical adopted repo. The LLM call cost is unchanged because the tightener's prompt size grows by the delta block only, which is bounded at ~500 tokens (capped by truncation if the delta itself is huge, with a "see harness_supersedes_chain" trailing pointer).

### 10.7 Implementation

```
harness-core/src/context/
├── handoff-builder.ts      — existing (run resume)
├── checkpoint.ts           — existing (75% snapshot)
├── spec-delta.ts           — buildSpecDelta(repoRoot, taskScopePaths) → SpecDelta | null
└── index.ts                — barrel
```

`spec-delta.ts` shares the same `simpleGit({ baseDir: repoRoot })` instance pattern as `handoff-builder.ts`. The orchestrator calls `buildSpecDelta` immediately before dispatching the tightener; if the result is non-null, it's injected into the tightener's system context.

### 10.8 Anti-patterns

| Anti-pattern | Why rejected |
|---|---|
| **Compute delta inside the tightener LLM call** | LLM should not be doing git log + ledger diff. Pure compute work; LLM only consumes the result. |
| **Delta against the entire repo (no scope filter)** | A repo-wide delta is mostly noise. The cutoff must be per-task — what changed since *this code* was last touched, not since project inception. |
| **Inject delta on every session start** | SessionStart fires at editor startup, not run start. Spec delta is a run-time concern; injecting it at SessionStart pollutes context with irrelevant changes. The tightener gate is the right place. |
