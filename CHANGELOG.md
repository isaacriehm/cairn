# Changelog

All notable changes to Cairn are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.7] — 2026-05-11

### Added

- **`cairn-direction` skill detects autonomy intent and offers a
  one-time mission-config flip.** When the operator's prompt
  contains an autonomy phrase ("execute autonomously", "just keep
  going", "run the whole mission", "don't pause", "until ctx",
  etc.) AND the active mission has `exit_gate: prompt`, the skill
  surfaces a single `AskUserQuestion`: "flip mission to
  `exit_gate: auto` so phase boundaries advance silently?". On
  `[a]` the skill calls the new `cairn_mission_set_exit_gate` MCP
  tool and stamps a per-mission marker
  (`.cairn/missions/<id>/.autonomy-prompted`). On `[b]` it stamps
  the marker without flipping. The marker prevents the question
  from re-firing every prompt for the same mission. Operators
  who change their mind delete the marker file to re-enable the
  question. Resolves the "I asked for autonomous, why does it
  keep asking" pain on missions where the operator wants to
  flip permanently but doesn't know about the roadmap.md
  frontmatter knob.
- **`cairn_mission_set_exit_gate` MCP tool.** Server-validated
  rewrite of the active mission's top-level `exit_gate`
  (`prompt | auto | manual`). Uses the existing
  `readRoadmap`/`writeRoadmap` helpers so the frontmatter stays
  schema-validated and per-phase `exit_gate` overrides are not
  touched. Journals an `exit-gate-changed` entry with the
  before/after gates. Returns `{ok, exit_gate, previous_exit_gate,
  changed}`; `changed: false` when the gate already matched the
  request (idempotent).

## [0.11.6] — 2026-05-11

### Fixed

- **Autonomous mission execution: `cairn_task_complete` now returns
  a `next_action_hint` block** so the model has a concrete next
  step after each successful task instead of ending the turn and
  waiting for the operator. The hint carries the active mission
  id, the cursor phase + title + exit criteria, and the list of
  tasks already graduated under that phase (so the model doesn't
  re-spawn already-done work). The `instruction` field is a
  literal directive: either call `cairn_task_create` for the next
  pending PR named in the exit criteria, or call
  `cairn_mission_advance({choice: "exit"})` when the exit criteria
  is fully covered but the auto-graduator hasn't moved the cursor
  yet, or end the turn cleanly when the mission has closed. Three
  kinds emitted: `continue-phase` (more work in the current
  cursor), `next-phase` (cursor auto-advanced under `exit_gate:
  auto`), `mission-complete` (last phase closed). The hint is
  suppressed when `phase_ready_to_exit` already owns the response
  (the AskUserQuestion takes precedence so the model doesn't race
  the operator prompt with an auto-create). Resolves the
  "autonomous mode keeps blocking after each task" gap where the
  model had no programmatic way to look up the next mission task
  and would end its turn after every `cairn_task_complete` call.
- **Stop hook now surfaces stalled `running` tasks.** A new
  `scanStalledRunningTasks` pass detects tasks stuck in
  `phase: running` with no attestation and no `status.yaml`
  activity for 30 min+ (upper-bounded at 7 days). These are
  tasks the autonomous flow finished but skipped the
  reviewer-spawn step on, so the auto-graduator never fired and
  the task accumulated as an orphan. The hint surfaces only when
  no higher-priority surface (reviewer-pending, ctx-threshold,
  phase-ready) already owns the reason channel, and instructs the
  operator via `AskUserQuestion`: `[a]` close all as succeeded,
  `[b]` spawn reviewer for each, `[c]` keep open. The hint
  honors the existing `review` defer state — picking "defer" on
  a reviewer-pending prompt suppresses the stalled prompt for
  the same task ids too.

## [0.11.5] — 2026-05-11

### Fixed

- **`cairn fix gitignore` and `cairn fix claude-rules` now find their
  bundled templates when invoked from the Claude Code plugin install
  path.** Both commands resolved templates via relative-ancestor walks
  off `import.meta.url`, but every candidate started two-or-more
  parent directories above `dist/cli.mjs` — none matched the actual
  bundle layout (`dist/templates/.cairn/.gitignore` and
  `dist/templates/.claude/rules/cairn.md`, both populated by the
  build-bundle mirror). Operators running
  `node ~/.claude/plugins/cache/isaacriehm-cairn/cairn/<ver>/dist/cli.mjs fix gitignore`
  saw `cannot locate bundled .cairn/.gitignore template (looked in …)`
  with four wrong paths and no way forward. Both candidate lists now
  start with `here/templates/<…>` so the plugin-install path resolves
  on the first probe; the source-layout candidates stay as fallback
  for `pnpm` workspace usage.

## [0.11.4] — 2026-05-11

### Fixed

- **Ctx meter now parses Claude Code v2.1.138's `context_window`
  payload.** CC changed the statusline payload schema: the window
  size is now reported as `context_window_size` and usage as a
  pre-computed `used_percentage`, replacing the older `total_tokens`
  / `remaining_percentage`-only fields. Cairn's decoder still looked
  for `total_tokens`, so every statusline tick on a v2.1.138 CC
  returned `ctx = null`, skipped the `ctx.json` persist, and
  rendered the badge without the `███░░░░░░░ NN%` segment. Decoder
  now keys on the new fields directly. Hard cutover — the old
  schema is no longer accepted. Operators on older CC builds
  update CC to get the meter back.

### Added

- **Per-tick statusline diagnostic at
  `.cairn/sessions/<id>/statusline-last.json`.** Captures the raw
  CC stdin payload (cap 8 KiB), the parse outcome, and the rejection
  reason on every statusline tick. Resolves "why is my ctx meter
  missing for this session" without instrumenting the CLI manually:
  the file shows whether CC shipped `context_window` at all, what
  fields it carried, and which decode branch (if any) rejected it.
  Overwritten each tick; no growth.

## [0.11.3] — 2026-05-11

### Fixed

- **Statusline no longer renders blank when a Claude Code session
  opens in a subdirectory of an adopted repo.** The `cairn status-line`
  CLI defaulted `projectRoot` to `process.cwd()` and never walked
  upward, so opening a session in `apps/web/` (or any nested folder)
  would miss the `.cairn/` lookup at the resolved cwd and return an
  empty string — CC then rendered no statusline at all. The dispatch
  now calls `resolveRepoRoot(cwd)` the same way the SessionStart,
  Stop, and UserPromptSubmit hooks do, falling back to the raw cwd
  only when no `.cairn/config.yaml` ancestor exists within 12 levels.
  Symptom: operators who launched Claude Code from anywhere other
  than the repo root saw the badge wink off for the entire session;
  the post-fix path renders consistently regardless of where the
  session started.
- **`.cairn/.gitignore` template tightened for tasks, missions,
  drafts, and per-clone runtime markers.** Seven new entries match
  the actual policy: `tasks/` and `missions/` are per-developer
  work-in-flight (shared knowledge lives in `ground/`, not in raw
  task or mission directories); `ground/decisions/_inbox/` is the
  operator-pending DEC review queue; `.gc-last-run`,
  `.mission-phase-deferred-until`, `state/telemetry/`, and
  `baseline/` are per-clone runtime artifacts that regenerate on
  the local machine. Projects adopted under v0.11.2 or earlier
  retroactively clean up via `cairn fix gitignore`, which rewrites
  the file from the bundled template and runs
  `git rm --cached -r --ignore-unmatch` against the newly-ignored
  paths so they drop out of the index. Untracked working state
  stops leaking into shared history.

## [0.11.2] — 2026-05-10

### Fixed

- **Statusline ctx meter no longer flickers off when CC pipes the
  payload slowly.** The `cairn status-line` stdin reader had a hard
  250ms deadline that fired unconditionally — any chunks already
  buffered when the timer expired were discarded, so the meter saw
  a null `context_window` block and dropped the `███░░░░░░░ N%`
  segment for that prompt tick. The reader now decodes whatever
  bytes have buffered when the deadline hits (instead of returning
  empty), auto-extends the deadline on every `data` event so a
  large payload streaming in slowly still completes, and raises
  the headline budget to 1.5s — well under CC's 10s refresh
  interval. Symptom: the operator would see the meter wink in/out
  between prompts; the post-fix snapshot persists to
  `.cairn/sessions/<id>/ctx.json` consistently each tick.

## [0.11.1] — 2026-05-10

### Fixed

- **SessionStart Active-mission banner now surfaces phase-ready
  hint + per-phase task counter.** When all linked tasks in the
  cursor phase have graduated and the phase `exit_gate=prompt`,
  the banner injects a `**Phase ready to exit**` block with the
  exact `cairn_mission_advance` call — re-derived from live state
  each session so the prompt survives `/clear` (the Stop-hook
  `phase-ready-pending.json` is session-scoped + consume-once and
  was dropping the signal after a context reset). Banner now also
  prints `tasks linked: N (X graduated, Y in-flight)` for the
  cursor phase, replacing the ambiguous bare-cursor line that was
  reading as "no work done" even after multiple successful task
  completions. Progress phrasing tightened from
  `progress: X/Y phases` to `progress: X of Y phases done` so the
  meaning is unambiguous on first read. The side-task callout was
  also reworded to spell out which kinds of work (regression
  fixes, unrelated refactors) belong outside the cursor's
  `phase_progress.task_ids`.
- **`cairn_mission_advance({choice: "not_yet"})` now clears
  `ready_emitted`** so the next task-completion in the deferred
  phase re-fires the operator-facing phase-ready prompt. Before
  the fix, picking `not_yet` once would silence the prompt until
  the cursor actually advanced (or the phase reopened), which
  matched the in-session idempotency intent but broke the
  long-form "remind me again when more work lands" flow.
- **`cairn_task_create` returns a `warning` field when an
  auto-attached task shares no signal-bearing token with the
  cursor phase's `title + exit_criteria`.** Caller can surface the
  warning + offer a `mission_id: ""` opt-out so unrelated work
  (boot regressions, side refactors) stops silently polluting
  `phase_progress.task_ids`. Non-blocking — explicit `mission_id`
  passes through untouched.

## [0.11.0] — 2026-05-10

### Changed

- **Context-threshold detection now trusts Claude Code's
  `context_window` payload exclusively.** The statusline hook reads
  `total_tokens` + `remaining_percentage` from CC's hook input and
  persists both to `.cairn/sessions/<id>/ctx.json`; the Stop hook
  reads that snapshot to decide whether to fire the 50%-window
  threshold prompt. Removed the transcript-usage and bytes/4
  fallbacks along with the model-keyed `modelWindow` lookup,
  `readModelFromTranscript`, and `estimateTokensFromTranscript`
  exports — when CC doesn't ship a `context_window` block the
  threshold check stays silent rather than firing on a guess. The
  statusline ctx meter also recolors on percentage rather than
  absolute tokens so a 200k Sonnet session and a 1M Opus-1m
  session signal danger at comparable points (green <50, yellow
  <70, orange <85, red).
- **Phase-exit prompt now fires once per phase.** Added a
  `ready_emitted` flag on `MissionPhaseProgressEntry` so a phase
  that has already surfaced `phase-ready-to-exit` stays silent on
  subsequent task completions until the cursor advances or the
  phase reopens. Stops the prompt-storm where every task
  completion in a `gate=prompt` phase re-fired the operator-facing
  surface even after the operator had already deferred.
- **Phase-ready surface moved off Stop hook `decision: "block"`.**
  Claude Code labels every Stop-hook block as "Stop hook error" in
  the UI; that framing reads as a real failure for an
  informational decision. The surface now flows through one of two
  clean channels: (1) when the model calls `cairn_task_complete`
  directly, the MCP response carries a `phase_ready_to_exit` block
  with a literal `render_instruction` and the model invokes
  `AskUserQuestion` in the same turn — no hook handoff; (2) when
  the Stop-hook auto-graduator graduates a task (attestation
  written without an explicit MCP call), it writes the hint to
  `.cairn/sessions/<id>/phase-ready-pending.json` and emits a
  non-blocking `systemMessage` operator notice. The
  UserPromptSubmit hook reads the pending file on the next prompt
  and injects via `additionalContext`.
- **Phase-exit prompt option labels cleaned up.** Dropped the
  `(choice: "exit")` tool-call tail visible in the AskUserQuestion
  options, dropped the "Defer 24h" option from the surfaced UI
  (still callable via direct MCP), and switched the question to
  use the phase TITLE rather than the bare phase id.

### Added

- `cairn_task_complete` MCP response now includes a
  `phase_ready_to_exit` block (mission/phase ids + titles + exit
  criteria + a `render_instruction`) when the completion satisfies
  a `gate=prompt` phase. The tool description directs the caller
  to surface via `AskUserQuestion` in the same turn.
- `phase-ready-surface.ts` — new module owning the Stop↔UPS
  pending-file shuttle and the shared `renderPhaseReadyHint`.
- `smoke-phase-ready-surface` — 5-step smoke covering the pending
  file write/consume cycle, the operator-facing markdown render,
  and end-to-end Stop→UPS injection.

## [0.10.4] — 2026-05-10

### Fixed

- **Statusline task segment now fits a 14" MacBook Pro terminal.**
  The task signal previously rendered the full canonical task id
  (`TSK-<slug>-<7hex>`) followed by the full module/title, producing
  90+ char overflows on small terminals. The signal now strips the
  slug body for display only — id renders as `TSK-<7hex>`, module
  ellipsis-truncates to fit a 45-char total budget. The on-disk id
  format is unchanged; the lens + CLI continue to use the
  canonical id verbatim.
- **`.claude/rules/cairn.md` trimmed.** The shipped project-level
  rule file dropped from 47 lines to 27 by collapsing the
  redundant "plugin installed" + "why this file exists" sections.
  The plugin probe + install instruction are the load-bearing part;
  the rest duplicated what the SessionStart context block and the
  `cairn-direction` / `cairn-attention` skills already say. Hot-path
  context savings on every conversation in adopted repos.

## [0.10.3] — 2026-05-10

### Fixed

- **Stop hook reason now self-labels as "not an error".** Claude
  Code labels every Stop-hook `decision: block` as "Stop hook error"
  in the UI — a CC convention Cairn cannot override. Operators who
  expanded the frame saw raw markdown headed by `## Cairn — phase
  ready to exit` (or similar) and assumed something failed. Cairn
  now prepends a one-paragraph preamble to every Stop reason
  explaining the "error" label is harmless, the block below is
  assistant context, and the agent should render any choices via
  `AskUserQuestion` rather than self-resolve.

## [0.10.2] — 2026-05-10

### Fixed

- **Phase-ready-to-exit hint no longer lets the agent self-resolve.**
  The Stop hook's phase-ready hint copy ended with "Operator picks
  via `cairn-attention` skill (or directly invoke
  `cairn_mission_advance`)" — agents took the parenthetical as
  permission to call `cairn_mission_advance` themselves, bypassing
  the operator entirely (one observed session auto-picked `not_yet`
  on a phase the operator had not yet looked at). Hint now mandates
  `AskUserQuestion` and explicitly forbids the agent from invoking
  the advance tool without an operator answer.

## [0.10.1] — 2026-05-10

### Fixed

- **`/cairn-resume` no longer 404s after auto-graduate race.** The
  Stop hook runs the task auto-graduator before the context-threshold
  check, so a task that completed in the same tick used to leave
  `findCurrentActiveTask` returning `null` while the AskUserQuestion
  template still offered `[b] /clear and resume now`. Operators who
  picked `[b]` then hit "no active task to resume" after `/clear`.
  The threshold prompt now branches on task presence: with no
  active task it surfaces only `[a] keep going` and `[b] /clear and
  start fresh (no resume)`. The `cairn_resume` MCP tool also falls
  back to `tasks/done/<id>/` when the active dir is missing,
  returning a `scope: "done"` payload with `completed_at` so the
  `/cairn-resume` slash command can render a "task already shipped"
  frame instead of erroring.
- **Statusline ctx %** falls back to transcript `usage` parsing when
  Claude Code omits the `context_window` payload block (older CC
  builds + some configs ship only one of the two fields). The
  fallback sums `input + cache_creation + cache_read` from the most
  recent assistant turn and pairs it with the model's window
  (Opus 1M / Sonnet 200k / Haiku 200k) so a fresh session no longer
  renders blank.
- **Local-dev plugin statusline shim.** `session-start.ts` now
  derives the plugin cache slug from a sibling
  `.claude-plugin/marketplace.json` when `CLAUDE_PLUGIN_ROOT` lives
  outside `~/.claude/plugins/cache/` (the typical local-dev
  marketplace layout). Locally-loaded Cairn now writes the same
  shim path as the cached install, so the statusline survives
  switching between the two.

### Added

- **`cairn-direction` Step 0.7 — auto-mission heuristic.** Multi-
  phase asks no longer silently collapse into a single task. When
  no mission is active, the skill scans the operator's prompt for
  five mission-shape signals (verb count, enumerated phases,
  multi-feature span, scope phrasing, length+structure) and
  surfaces a `[a] mission [b] single task` AskUserQuestion when
  any 2+ trigger. On `[a]`, the skill writes the prompt to
  `.cairn/missions/_drafts/<slug>.md`, calls `cairn_mission_start`,
  surfaces the drafted phase roadmap for operator approval, and
  commits via `cairn_mission_accept_draft`. The CLI surface
  (`cairn mission start <spec>`) remains for operator-driven
  flows from hand-written planning docs.

## [0.10.0] — 2026-05-10

### Added

- **Mission system — supra-task layer for multi-phase plans.**
  Cairn previously had one unit of work (`TSK-`), so a single
  tightened spec scoped to one or two files. That broke down on
  large multi-phase plans: the agent created a task for the
  current slice, but the rest of the plan was invisible. After
  `/clear`, the operator had to re-paste the whole plan into a
  fresh chat. Missions add a persistent "what we're working on
  across sessions" object — a doc-anchored cursor (committed
  `roadmap.md` + per-clone `state.json` + frozen `spec.md`
  snapshot + `journal.jsonl`) with phase-by-phase progress,
  lazy task spawn anchored to the current cursor phase, and a
  resume prompt that re-primes the mission frame in front of
  the existing task journal. One active mission per repo;
  side-tasks spawn without a mission tag.
  - **Eight new MCP tools**: `cairn_mission_start` (Haiku
    drafts the roadmap from a planning doc), `cairn_mission_accept_draft`
    (commits the operator-approved roadmap), `cairn_mission_get`,
    `cairn_mission_advance` (`exit` / `not_yet` / `defer` / `force`
    / `drop`), `cairn_mission_close` (manual close + `--abort`
    path), `cairn_mission_resume` (chained from `/cairn-resume`),
    `cairn_mission_resync` + `cairn_mission_resync_accept`
    (operator amended the source spec; surfaces a diff for
    explicit accept/reject), `cairn_mission_reopen`.
  - **Per-mission exit gate, optionally per-phase**: `prompt`
    surfaces an inline `[a]/[b]/[c]` in the Stop hook reason
    block when all linked tasks for the active phase graduate;
    `auto` advances the cursor silently; `manual` waits for the
    operator. Per-phase override in roadmap.md frontmatter for
    one risky phase that should keep `prompt` while the rest
    are `auto`.
  - **Statusline**: appends `✓ <mid-slug> · <phase-id> (N/M)`
    when a mission is active. Slug auto-truncates with `…` to
    fit the 40-char budget.
  - **SessionStart**: ground-state context block carries a new
    `Active mission` section with the cursor phase, exit
    criteria, drift warning, and a one-liner explaining
    automatic mission anchoring on new tasks.
  - **`cairn-direction` skill**: Step 2.5 mission preflight
    auto-anchors the spawned task to the cursor phase; surfaces
    a single AskUserQuestion when the operator's prompt is
    orthogonal to the active phase (`side-task` /
    `fold-into-phase` / `advance-to-different-phase`).
  - **`cairn-attention` skill**: Step 0.2 resolves
    phase-ready-to-exit, mission_drift, and mission_resync_pending
    surfaces inline.
  - **`/cairn-resume` command**: chains the mission frame body
    (cursor + last 3 graduated tasks + in-flight tasks + sliced
    spec section + next 1-2 phases) before the existing task
    journal frame. Total resume budget: ≤2500 tokens.
  - **CLI parity**: `cairn mission {start,accept,get,list,advance,close,reopen}`
    for headless / debug paths.
  - **Task linkage**: `cairn_task_create` accepts optional
    `mission_id` + `phase_id` (defaults to active mission's
    cursor; `mission_id: ""` opts out for explicit side-tasks).
    `cairn_task_complete` emits a `phase-ready-to-exit`
    invalidation event under `gate=prompt` and advances the
    cursor under `gate=auto` when the last linked task on a
    phase graduates. Linkage is centralized inside
    `completeTask` so the Stop hook auto-graduator path picks
    it up automatically.

## [0.9.8] — 2026-05-10

### Fixed

- **ctx-threshold uses real token count, not transcript bytes/4.**
  The Stop-hook context-window warning was estimating usage from
  `statSync(transcriptPath).size / 4`. Transcripts are append-only
  JSONL of every turn + every tool I/O blob, so the estimate
  systematically over-counted by ~1.5–2x — a session at real
  ~45% (`/context` truth) fired the 50% threshold at displayed
  74%. Statusline already receives the real
  `context_window.{remaining_percentage, total_tokens}` from
  Claude Code on stdin; it now persists the snapshot to
  `.cairn/sessions/<id>/ctx.json` on every render, and the Stop
  hook reads that file first (falling back to `bytes/4` only
  when missing or >5min stale). Result: 50% means real 50%.
- **Bypass record/accept now actually clears the warning.**
  `cairn_resolve_attention({kind: "bypass", choice: "a"|"b"})`
  was clearing the defer file but never appending the resolved
  SHAs to `.cairn/.attested-commits` — the only file the bypass
  detector reads. Operators picking "record bypass" or "accept"
  saw the same warning re-fire on every Stop tick forever; the
  only escape was manually `git rev-parse $sha >>
  .cairn/.attested-commits`. The tool now expands short→full
  SHAs via `scanBypassedCommits`, dedupes against the existing
  file, and appends the matches before returning. Response
  carries `attested_count` so the calling skill can confirm the
  write took.
- **Auto-graduated tasks now surface in the Stop reason.**
  `autoGraduateTasks` was logging `auto_graduated_completed:N`
  to telemetry but emitting nothing to the operator. The skill
  graduated the active TSK silently and the operator saw no
  acknowledgement. The Stop hook now prepends
  `## Cairn — N tasks graduated\n\n✓ TSK-x → done.` to the
  reason text whenever a task transitions to `done` on a Stop
  tick.

## [0.9.7] — 2026-05-10

### Added

- **Diff-aware sot-align short-circuit.** `executeSotAlign` now
  reads `tool_input.{old_string, new_string}` (Edit) or
  `tool_input.content` (Write) and skips the per-edit alignFile
  pass entirely when neither contains an essay-class comment shape.
  Variable renames, type tweaks, single-line bugfixes, and any
  non-prose Edit therefore burn 0 Haiku calls instead of up to
  ~30s of Tier 2/3 dedup latency. Detector
  (`containsEssayClassShape` in `hooks/sot-align-common.ts`)
  matches JSDoc blocks (`/** ... */`), JSDoc continuation lines
  (`*<space><non-space>`), 3+ consecutive `//` lines, and Python
  triple-quote docstrings. False-negatives — e.g. a single non-`*`
  line tweak inside a pre-existing `// 3+` block — get caught at
  commit boundary by Layer B's pre-commit pass + `cairn fix
  align`. New smoke `smoke-essay-shape-detector` covers the
  detector regex with 14 cases (8 expected-skip, 5 expected-run,
  1 documented false-positive).

## [0.9.6] — 2026-05-10

### Fixed

- **Statusline phase label `5b-topic-index` → `7-topic-index`.**
  `buildTopicIndex` was writing `phase: "5b-topic-index"` into
  `.cairn/init/progress.json`, so the statusline rendered
  `⏳ adopt 5b-topic-index 63/84 (75%)` while the cairn-adopt skill's
  prompt said "Phase 7-topic-index — cross-source dedup pre-pass."
  The `5b-` label was the legacy plan-§5.1 numbering before the
  pipeline collapsed `7-topic-index → 8-docs-ingest → 9-source-comments`
  into the current 7/9a/9b/9c sequence. Statusline now reads
  `⏳ adopt 7-topic-index X/Y`. Stale `phase 5b` references in
  hook comments (`sot-align.ts`, `sot-align-precommit.ts`) updated
  for consistency — code-only, not user-visible.

## [0.9.5] — 2026-05-10

### Fixed

- **Phase 6 brand-derive timeout 60s → 180s.** Haiku's structured-output
  path for the 4-field brand schema on a 2-3kB context is consistently
  25-50s on plan quota and occasionally tips past 60s during upstream
  slowness. The previous ceiling fired the fallback path
  (`Developers and operators working on <slug>` placeholder
  `mainUsers`), leaving the operator with mechanical defaults until
  they re-ran `cairn fix brand`. The retry path inside
  `deriveBrandFromProject` still catches transient blips beneath the
  new ceiling.
- **`cairn_init_run` now clears `init-state.json` on terminal
  completion.** Phase 13-multidev returns `nextPhase: null` to signal
  the pipeline is done; the MCP tool was supposed to call
  `clearPhaseState(repoRoot)` at that point but instead persisted the
  state file again via `writePhaseState`. Result: every freshly-adopted
  repo carried `.cairn/init-state.json` forever, which made the
  `cairn-adopt` skill's mid-adoption probe + SessionStart's
  `renderMidAdoptionBanner` classify the repo as "mid-adoption"
  on every subsequent session. Now terminal completion deletes the
  file; non-terminal completions still write through. Cleanup-failure
  recovery (filesystem error during clear) is still handled by
  `resumePhases` returning `ready / 13-multidev` so an idempotent
  re-invoke retries the clear.

## [0.9.4] — 2026-05-10

### Added

- **`StubPattern.must_contain` post-filter.** Schema + runner accept
  an optional inner regex applied to the outer regex's matched text.
  Finding only emits when the inner regex matches at least once
  inside the captured block. Lets a coarse outer pattern (e.g. "3+
  consecutive `//` lines") gate on a structural signal (e.g. "the
  matched text contains a code-shaped construct"). Without the gate,
  the outer regex captured every license header / doc preamble /
  AI-annotation block as "commented-out code." Generic mechanism —
  any pattern can opt in.

### Fixed

- **`commented-block-3-plus-lines` no longer floods on doc preamble.**
  Outer regex matches every 3+-line `//` block, including license
  headers, AI annotations, narrative section dividers — none of which
  are commented-out code. Added `must_contain` anchored to
  `//`-line-start requiring a structural code-shape:
  `(const|let|var) NAME =`, `function NAME(`, `return X;`,
  `if (...) {`, `while (...) {`, `for ((let|const|var) ...`,
  `import {/*/'/"`, `export (default|const|...)`, or
  `name(args);`. The leading `^[\t ]*//\s*` anchor (multiline mode)
  rejects narrative-with-inline-code-reference like
  `// use this.active() → currentTx(); on success`. Real
  commented-out-code blocks (lines whose content directly is a
  declaration / call / return) still match. On a typical
  monorepo this drops the commented-block hit count by ~99%
  (399 → 0 on the test fixture; the remaining audit is dominated
  by other patterns whose findings are real).

## [0.9.3] — 2026-05-10

### Fixed

- **Stub-pattern catalog: `empty-async-body` downgraded hard → soft.**
  The regex `async (...) => {}` matches both real empty stubs and
  legitimate mock factories (`vi.fn(async () => {})`,
  `jest.fn(async () => {})`, no-op event-handler defaults). Hard
  severity failed adoption baseline on test files where the empty
  body is the contract; downgrading to soft keeps the signal
  visible in attestation cross-check (`stubs_introduced` count
  becomes a lie if matches appear in new code) without flagging
  test mocks as actionable attention. After the 0.9.2 attention-count
  filter, soft findings stay out of `⚑ N pending` automatically.

### Added

- **`StubPattern.skip_globs` per-project escape hatch.** Schema +
  runner now accept an optional `skip_globs: ["..."]` array on each
  pattern entry; the matched diff entry's path is checked against
  the globs before regex evaluation. Operator opt-in only — the
  shipped catalog ships zero defaults to keep the core
  language-agnostic. Adopters extend
  `.cairn/config/stub-patterns.yaml` per-project when their stack's
  test conventions trip a specific pattern.

## [0.9.2] — 2026-05-10

### Fixed

- **Statusline `⚑ N pending` no longer counts soft baseline findings.**
  `attention_count` was a flat sum of `pendingDrafts + baselineFindings
  + driftFindings`, where `baselineFindings` was the *total* count from
  the latest sensor audit including every `severity: soft` match. The
  `commented-block-3-plus-lines` pattern alone produced 500+ soft hits
  on a typical adoption (every 3+-line `//` block in test files,
  fixtures, JSDoc-adjacent comments) — the operator saw "⚑ 517 pending"
  and couldn't drain it item-by-item because soft findings are
  inventory for the attestation cross-check, not actionable attention.
  `readLatestBaselineAudit` now walks `sensors[].findings[]` and tallies
  by severity; `attention_count` only counts hard baseline findings.
  The first-session onboarding section breaks the audit total into
  `(N hard · M soft)` and routes the operator to triage hard findings
  via `cairn-attention` while flagging soft as bulk-drain inventory.

## [0.9.1] — 2026-05-10

### Fixed

- **Phase 3 mapper — per-module Sonnet timeout bumped 180s → 600s.**
  Sonnet with `--json-schema` and a fat `scope_index.files` output
  (one entry per file in the module) on a 35k-char prompt can
  legitimately run 4-6 minutes. The 180s ceiling was timing out on
  legitimate large modules in monorepos with sizable
  `core/src`-style packages.
- **Phase 3 mapper — flipped failure policy from all-failed to
  any-failed.** Previously a single timed-out module silently
  downgraded to a `failed: true` proposal (confidence 0.1, empty
  globs, blanket-`unscoped: true` scope index) and the merge step
  proceeded — seeding ground state with degraded scope coverage and
  no surface error to the operator. Now any module failure throws
  from `runMapper`; Phase 3 returns `error` and preserves
  `init-state.json` so the operator can re-run. Successful module
  proposals are persisted to the on-disk Claude cache
  (`cacheable: true` was already wired); a re-run only re-issues
  the failed slice — completed modules hit the cache instantly and
  don't burn coding-plan quota a second time.
- **Phase 6 brand — auto-derive personas now write structured entries
  instead of mashing into a single `name: primary` line.** The
  Haiku-derived path returned 1-3 named personas, but
  `derivedToBrandAnswers` joined them with ` · ` into a single
  `mainUsers` string and `rewritePersonas` wrote that mash as one
  `name: primary` entry's description. New `BrandAnswers.personas`
  array carries the structured shape; `applyBrandAnswers` writes one
  YAML entry per persona via `rewritePersonasStructured`. The
  freeform interactive-prompt path (single sentence) keeps the
  `name: primary` collapse behavior since the operator answered with
  one line.
- **Phase 4 seed — canonical-map template trimmed of Cairn-internal
  topics.** Template shipped with `cairn-architecture`,
  `cairn-mcp-surface`, `cairn-filesystem-layout`, and
  `cairn-plugin-architecture` entries pointing at Cairn's own `docs/*`
  files — useless dead links for adopters whose project doesn't
  contain those docs. Template now ships only the universal
  `agents-md` and `claude-md` entries; adopters extend per project.
- **Phase 13 multidev — finalize step now rebuilds
  `ground/manifest.yaml`.** Manifest was previously empty
  (`files: []`) at the end of adoption — `writeManifest()` only ran
  from the GC canary path, so a freshly-adopted repo had to wait
  for the first commit before the manifest reflected reality. Runs
  as a non-fatal finalize step in Phase 13; failures log a warning
  but don't abort the phase.

### Removed

- **`ground/capabilities/` directory ripped — no consumer.** Audit
  found `mcp-tools.yaml`, `snippets.yaml`, and
  `capabilities/skills.yaml` had zero readers anywhere in the
  codebase: no MCP tool, no skill, no agent, no hook, no
  SessionStart context-builder. Templates' own comments claimed
  "Read at SessionStart" — false. Removed from `templates/`,
  `docs/FILESYSTEM_LAYOUT.md`, and the in-flight `phase-13`
  populator (`src/init/capabilities-skills.ts`). `topics.yaml`
  under `canonical-map/` is the only remaining ground inventory
  surface, and it has a real consumer
  (`cairn_canonical_for_topic` MCP tool, called by the
  `cairn-direction` skill). The 20s ceiling
  was tripping the timeout classifier on legitimate slow Haiku calls
  during sustained network or upstream-latency events; classified
  timeouts then either tripped the breaker prematurely or
  accumulated as `unresolvedAmbiguous` with no actual semantic
  failure. 30s is the realistic upper bound for a single
  semantic-similarity verdict; anything longer is genuinely stuck.
- **Cache observability — `runClaude` cache hits now emit a
  `cache_hit` trace row and surface a `cached: boolean` flag on
  `RunClaudeResult`.** Previously cache hits were invisible in
  `~/.cairn/trace/trace-*.jsonl` (only fresh subprocess calls hit
  `appendTrace`), so an operator post-mortem couldn't distinguish
  "cache hit served the verdict" from "no judge call dispatched."
  Phase 7's `TopicIndexPhaseOutput` now splits `judge_calls` into
  `judge_calls_cached` / `judge_calls_fresh` / `judge_calls_errors`
  via a new `JudgeTally` counter threaded through `makeHaikuJudge`
  — operators verifying a re-run-after-rate-limit can now read
  exact cache-hit vs fresh-call counts straight off
  `init-state.json` instead of inferring from elapsed wall-time.
- **Adoption — mid-adoption resume now works after a partial run.**
  Phase 4-seed writes `.cairn/config.yaml` early in the pipeline, so
  any session opened after Phase 4 (the common case for an interrupted
  adoption — `/exit`, rate-limit bail, crash) saw the
  `resolveRepoRoot` gate match the repo as fully-adopted. Result:
  SessionStart suppressed the adoption banner and the `cairn-adopt`
  skill's trigger gate aborted with "already adopted." The skill now
  classifies into three buckets — `fresh`, `mid-adoption:<phase>`,
  `adopted` — by probing for `.cairn/init-state.json` first, and
  jumps straight to `cairn_init_resume` when `init-state.json`
  exists. SessionStart adds a third banner (`renderMidAdoptionBanner`)
  that fires on `init-state.json` presence and instructs the agent
  to invoke `Skill(cairn:cairn-adopt)` on the first operator reply.
- **Phase 7 topic-index — quota / sustained-failure breaker now
  surfaces as a phase error instead of a silently-partial topic
  index.** The previous breaker tripped only on `auth` or
  `isQuotaKind` (rate_limit / overloaded) classifications, and even
  when it tripped, `resolveTopics` still returned a partial result
  — the writer then persisted a truncated `topic-index.yaml` +
  `anchor-map.yaml` to ground state and Phase 7 advanced. Rate-limit
  wording the regex didn't match (e.g. plan-quota messages classified
  as `other`) accumulated as `unresolvedAmbiguous` with no breaker,
  no surface error, and full advance through 8 → 9a. Replaced
  `consecutiveTimeouts` with `consecutiveFails` (any error kind
  increments); breaker now records `firstFatalErr` on quota/auth
  immediately or on `consecutiveFails ≥ 5` of any kind, and rethrows
  after the worker pool drains. `index.ts`'s try/catch already
  prevents the partial write, so Phase 7 wraps as `status: "error"`
  and the orchestrator stops. Successful judge verdicts are cached
  (`cacheable: true` on the Haiku call) so re-running after the
  rate-limit window resets only retries the small failed subset.

## [0.9.0] — 2026-05-10

Adoption rewrite: the `8-docs-ingest`, `9-source-comments`, and
`10-rules-merge` Haiku batch pipelines collapse into one unified
**curator pipeline** under Sonnet plan-quota subagents. Old pipelines
ran first-line `prose.split("\n")[0].slice(0, 120)` titles and pasted
verbatim raw blocks into DEC bodies; on a typical ~50-package
monorepo that produced 129 DECs + 169 INVs of mostly mid-sentence
fragments, JSX leakage, and unsynthesized JSDoc tags. The new
pipeline produces 30-80 synthesized entries with strict validators —
auto-accepted into ground state because the quality bar is hard, not
deferred.

Hard cutover. `init-state.json` schemaVersion bumped 2 → 3; stale
mid-init state files are treated as missing and adoption restarts
from Phase 1.

### Added

- **Phase 9a-walker / 9b-curate / 9c-emit** replace `9-source-comments`.
  - **9a-walker** (`packages/cairn-core/src/init/curator/walker.ts`)
    — deterministic, no LLM. Runs three sub-walkers (source comments,
    doc paragraphs ≥80 chars, rule sections) and applies a regex
    pre-filter that drops 60-80% of raw blocks (test files, JSX block
    comments, license headers, JSDoc with only @tags, TODO-only
    banners, `.archive/` paths, `mapper.off_limits_globs`). Survivors
    write to `.cairn/init/curator/corpus.jsonl`. Records pack into
    shards capped at 120k input tokens by module + directory
    hierarchy (never random shard) and persist to `shards.json`.
  - **9b-curate** is a skill-driven pseudo-phase. The `cairn-adopt`
    skill spawns `cairn:curator-map` subagents per shard in parallel
    rounds of 4, then one `cairn:curator-reduce` subagent over the
    aggregated candidates. Subagents are plan-quota Sonnet 4.6 only —
    no API billing. The MCP runner only confirms `final.jsonl` exists
    + counts entries before advancing.
  - **9c-emit** (`packages/cairn-core/src/init/curator/emit.ts`)
    validates each `final.jsonl` entry against
    `packages/cairn-core/src/init/curator/validate.ts` (title ≤80
    chars + capitalized + no `...`/`{/*` leakage; body has the literal
    `## Context / ## Decision / ## Why` or `## Invariant` template;
    no `@domain`/`@orgScope`/`@see`/`@param`/`@returns` JSDoc tag
    leak; title not pasted in body; ≥1 `scope_globs`; ≥1
    `evidence_files` that resolve to real files). Survivors write
    directly to `.cairn/ground/decisions/<id>.md` with `status:
    accepted` and `capture_source: init-curator`, or
    `.cairn/ground/invariants/<id>.md` with `status: active`.
    Frontmatter carries new `evidence_files` + `topic_tags` arrays.
    Invalid entries drop silently with a per-reason counter logged.
- **Subagent definitions**:
  `packages/cairn-frontend-claudecode/agents/curator-map.md` and
  `curator-reduce.md`. Map subagents cap at ≤15 entries per shard
  (≤8 preferred), enforce imperative titles, drop borderline cases.
  Reducer enforces 30-80-entry final cap (target 40-60), prioritizes
  high-stakes (auth, billing, multi-tenant, payments, route
  handlers), generalizes scope globs from cited evidence.
- **`smoke-curator-validate`** (20 cases) feeds clean DECs / clean
  INVs / every documented failure mode into `validateEntry` and
  asserts the expected drop-vs-emit decisions. Added to the smoke
  gate.
- **`smoke-init-phases-all`** grew Step 8 (phase 8 + 10 no-op
  markers), Step 9 (9a-walker end-to-end on a fixture repo), Step
  10 (9b-curate errors when `final.jsonl` missing), Step 11 (9c-emit
  emits validated entries + drops the rest).

### Changed

- **`init-state.json` schemaVersion 2 → 3.** Hard cutover — state
  files written by 0.8.x fail validation and are treated as missing.
  Adoption is one-shot per repo; restart is acceptable. zod schema
  in `cairn_init_run` updated to `z.literal(3)`.
- **PHASE_IDS** drops `9-source-comments`, adds `9a-walker`,
  `9b-curate`, `9c-emit`. The runner registry in
  `packages/cairn-core/src/mcp/tools/init-phases.ts` registers the
  three new runners.
- **Phase 8-docs-ingest + Phase 10-rules-merge** collapse to no-op
  markers that stamp `skipped: "merged-into-9-curator"` and advance.
  The runners stay registered so resumes from old `init-state.json`
  files don't blow up; the operator-facing banner table in
  `cairn-adopt/SKILL.md` no longer lists them.
- **`cairn-adopt/SKILL.md`** Step 3.5 documents the curator
  orchestration (read `shards.json`, slice per-shard inputs,
  dispatch `curator-map` in parallel rounds of 4, dispatch
  `curator-reduce`, then call `cairn_init_run` for `9b-curate` to
  advance state). Step 5 summary jq query reads from `9c-emit`
  (`decsWritten` / `invsWritten` / `dropped`) instead of the old
  per-pipeline output fields. `allowed-tools` extends to
  `Task(curator-map), Task(curator-reduce)` for subagent dispatch
  pre-approval.

### Removed

- **`packages/cairn-core/src/init/phases/9-source-comments.ts`**
  deleted. Replaced by `9a-walker.ts` + `9b-curate.ts` +
  `9c-emit.ts`.
- **`packages/cairn-core/src/init/phases/parallel-8910.ts`** deleted.
  The fan-out runner that overlapped Phase 8/9/10 on wall-clock is
  no longer needed — curator orchestration in the skill replaces it.
  `runPhases8910Parallel` export removed from `cairn-core`.
- **`packages/cairn-core/src/init/phases/source-comments-output-io.ts`**
  deleted. The lightweight projection it spilled to disk is no
  longer needed; curator output is its own JSONL stream.
- **`runPhase9SourceComments`, `runPhases8910Parallel`,
  `SOURCE_COMMENTS_WALK_PATH`** and related exports removed from
  `@isaacriehm/cairn-core`. Callers must switch to
  `runPhase9aWalker`, `runPhase9bCurate`, `runPhase9cEmit`.

### Migration

Existing `.cairn/` state stays valid. Decisions + invariants emitted
by 0.8.x stay on disk under their original ids; the curator pipeline
on the next adoption (or `cairn init --force`) writes new entries
alongside without touching prior ones. `cairn attention` continues
to drain pre-existing inbox drafts as before.

The `init-state.json` schemaVersion bump only affects in-flight
adoptions — sessions interrupted mid-init under 0.8.x will be
treated as fresh starts on the first 0.9.0 session. Re-running
adoption is the supported recovery path.

## [0.8.3] — 2026-05-10

Hotfix: fresh adoption deadlocked at Phase 1-detect because
`cairn_init_resume` never seeded `.cairn/init-state.json` to disk.

### Fixed

- **Fresh adoption deadlock at Phase 1-detect.** `cairn_init_resume`
  constructed `freshPhaseState(repoRoot)` but didn't persist it.
  The cairn-adopt skill driver follows SKILL.md ("tool reads state
  from disk") and omits the `state` arg on the next `cairn_init_run`
  call — that handler then read disk, found nothing, and returned
  `VALIDATION_FAILED ... no init state at .cairn/init-state.json`,
  bouncing the loop. `cairn_init_resume` now writes the fresh
  `PhaseState` (creating `.cairn/` upfront) so the next `init_run`
  finds something to read. Existing-state callers are unaffected —
  the seed-write only fires when `readPhaseState` returns null.

## [0.8.2] — 2026-05-10

Hotfix patch on top of 0.8.1: SessionEnd hook output now passes
Claude Code 2.1+ schema validation, and `cairn_init_run`'s zod
state schema agrees with the on-disk v2 format so adoption no longer
deadlocks after Phase 1.

### Fixed

- **SessionEnd hook output rejected by Claude Code 2.1+.** Hook ran
  `emitShapeB("", "SessionEnd")` which wraps the payload in
  `hookSpecificOutput` — Claude Code 2.1+ refuses that envelope for
  SessionEnd and surfaces `Hook JSON output validation failed —
  (root): Invalid input.` New `emitContinue()` helper writes a bare
  `{continue: true}` payload; SessionEnd runner switched to it.
- **`cairn_init_run` zod state schema** still required
  `schemaVersion: z.literal(1)` after the disk-format bump to v2.
  Drivers passing explicit fresh state (`freshPhaseState` now emits
  v2) failed zod parsing while disk reads via `isPhaseState`
  expected v2 — the loop got stuck after Phase 1 with
  `VALIDATION_FAILED ... no init state at .cairn/init-state.json`.
  Bumped the zod literal to `2` so input + on-disk shapes agree.

## [0.8.1] — 2026-05-10

Adoption UX patch: kills the Phase 5 pilot-module prompt that
confused operators on multi-package monorepos, replaces it with a
no-input pre-flight ETA so the operator sees an honest pre-commit
estimate before the long Haiku phases run, and fully removes the
`pilot_module` field from the mapper / config / overlay surface so
adoption always covers the whole repo. Hard cutover — `init-state.json`
schema bumped to v2, stale mid-init state files are ignored on the
next session and adoption restarts from Phase 1.

### Added

- **Phase 5 pre-flight ETA.** New `runPhase5Preflight` walks the
  source tree once (no Haiku), counts the units each long phase will
  process — markdown paragraphs, essay-class comment blocks,
  rule-file H2 sections, jaccard pair estimate — and emits a
  rendered banner the cairn-adopt skill prints verbatim before
  invoking `6-brand`. Phase auto-advances; no operator input.
- **ETA calibration cache** at `~/.cairn/cache/eta-calibration.json`.
  Per-machine, per-phase `secondsPerUnit` averaged via EWMA
  (α=0.3 for first 5 samples, α=0.1 thereafter; outliers clipped at
  10× prior rate). Phases `7-topic-index`, `8-docs-ingest`,
  `9-source-comments`, and `10-rules-merge` write measured rates
  back after each successful run, so subsequent adoptions on the
  same machine converge to ±20% accuracy in 3–4 runs. Shipped
  defaults seed first-run estimates.

### Changed

- **`init-state.json` schemaVersion bumped 1 → 2.** Hard cutover —
  state files written by 0.8.0 fail validation and are treated as
  missing on the next session, restarting adoption from Phase 1.
  Adoption is one-shot per repo; restart is acceptable.
- **Phase 5 renamed `5-pilot` → `5-preflight`.** PHASE_IDS reordered
  accordingly; MCP runner registry updated; `runPhase5Pilot` export
  replaced with `runPhase5Preflight`. Smoke `smoke-init-phases-all`
  Step 3 rewritten to assert auto-advance + bannerLines + numeric
  ETA.

### Removed

- **`pilot_module` field deleted everywhere.** No more pilot scoping.
  Mapper schema (`pilot_module` from `MAPPER_OUTPUT_SCHEMA` +
  `MapperOutput`), per-module Sonnet schema (`pilot_module_candidate`
  from `mapper-parallel.ts`), Haiku merge prompt, project overlay
  (`.cairn/config.yaml`), workflow.md slug-block (`pilot_module: ALL`
  template line), trust-policy `change_pilot_module` configuration
  command, scoring bias (`inPilot` from `attention/scoring.ts` +
  `pilotModule` from `bulk-accept` + tool wrappers), and CLI prompt
  (`freeTextWithDefault` pilot prompt + `Pilot` printout) all gone.
  Adoption always covers the whole repo; operators narrow surface
  area later via `cairn scope`.

## [0.8.0] — 2026-05-09

Major reliability + UX pass ahead of v1: task lifecycle now graduates
end-to-end, statusline carries a positive heartbeat, doc-vs-runtime
drift is caught automatically, adoption is hardened against
WSL/PowerShell + plugin-slug + skill-listing-budget failure modes,
and the bootstrap-fail surface no longer exposes CLI subcommands.
Smoke gate grew from 27 to 38; typed MCP tool count grew from 25
to 29. Workspace grew to five packages with the addition of
`cairn-state`.

### Added

- **Task lifecycle complete loop.** New module
  `packages/cairn-core/src/tasks/lifecycle.ts` exposes
  `completeTask`, `transitionTaskPhase`, `readTaskAttestationState`,
  `appendTaskJournal`, `readTaskJournal`, `findCurrentActiveTask`.
  New MCP tools `cairn_task_complete`, `cairn_task_journal_append`,
  `cairn_resume`. Stop hook auto-graduates `running` →
  `succeeded` / `ready_for_review` based on attestation presence
  and reviewer flags. Reviewer subagent calls `cairn_task_complete`
  after writing `attestation.yaml`. New
  `/cairn-resume <task_id>` slash command.
- **Cairn-as-resume-layer.** Per-turn task journal
  (`.cairn/tasks/active/<id>/journal.jsonl`); Stop hook fires inline
  `[a] keep going / [b] /clear and resume / [c] mark task done` when
  transcript size proxy crosses 50% of the active model's window
  (Opus 1M, Sonnet/Haiku 200k). SessionStart auto-detects active
  tasks with prior-session journal entries and injects a
  resuming-cold banner.
- **Doc-vs-runtime drift sensor.** GC pass 10 `doc-claims-vs-runtime`
  scans `README.md`, `CLAUDE.md`, and `docs/*.md` for extractable
  claims about `packageCount`, `smokeCount`, `mcpToolCount`, and
  `hookEventCount`; runtime read from package manifests, the smokes
  chain, the MCP `allTools` array, and the plugin `hooks.json`.
  Findings surface as conflict A/B/C: regenerate / file task /
  defer.
- **Doc-source-drift GC pass.** GC pass 11 walks every DEC's
  `sot_path`, recomputes `bodyContentHash`, and compares against the
  stored hash. Surfaces three new finding kinds: `doc_source_drift`,
  `sot_missing`, `sot_anchor_missing`. Closes the externally-edited-
  doc loop the existing PostToolUse `sot-align` hook misses.
- **Stop-driven GC autotrigger.** Stop hook spawns a detached
  `gc sweep` subprocess when `.cairn/.gc-last-run` is missing or
  older than 24h. Idempotent; failures degrade silently.
- **Statusline idle heartbeat.** When ground state is non-zero,
  idle render shows `⬡ cairn  ✓ <decisions>·<invariants>` instead
  of bare brand mark. Operator sees Cairn is alive without an
  exception event.
- **Skill-listing budget auto-bump.** Phase 1 detect raises
  `skillListingBudgetFraction` to `0.03` in
  `~/.claude/settings.json` so Sonnet/Haiku stop dropping
  `cairn-direction` from the listing on machines with ~20+ user
  skills. Idempotent; non-numeric / above-floor values preserved.
- **Bootstrap-retry MCP tool.** New `cairn_bootstrap_retry` re-runs
  per-clone bootstrap inline when SessionStart's auto-bootstrap
  failed. Replaces the previous CLI-subcommand exposure in
  `bootstrap-guard.ts` remediation (plugin spec §11 violation).
- **`cairn doctor` version-skew check.** Reads
  `.cairn/config.yaml#cairn_version`, compares to running `VERSION`.
  Surfaces warn on mismatch with a per-version remediation hint;
  warn on missing key / missing config; ok on match.
- **WSL/PowerShell git auto-config.** Phase 1 detect runs
  `git config --local safe.directory <abs>` and
  `git config --local core.fileMode false` when WSL is detected
  (`/proc/version` matches `Microsoft|WSL`). Closes the
  `dubious ownership` failure on cross-platform clones. The
  cairn-adopt skill also runs both calls after driving its own
  `git init`.
- **Self-adoption guard re-wired.** `isCairnSourceRepo()` rebuilt
  on top of `packages/cairn-core/package.json#name`,
  `packages/cairn-frontend-claudecode/package.json`, and
  `pnpm-workspace.yaml` markers. Wired into the MCP path
  (`cairn_init_run` Phase 1 detect) — adoption refuses with a
  `cairn-source-repo` envelope. `CAIRN_SELF_ADOPT=1` env override
  for legitimate dogfood. Phases 8/9/10/12 + `parallel-8910` short-
  circuit when `is_self_adopt` is true so the recursive-ingest
  scenario (Cairn's own docs / source comments / CLAUDE.md / essay
  comments) cannot run against the source tree.
- **11 new smokes** lock the new contracts:
  `smoke-task-lifecycle`, `smoke-task-resume`, `smoke-doc-claims`,
  `smoke-doc-source-drift`, `smoke-gc-autotrigger`,
  `smoke-wsl-git-init`, `smoke-skill-budget`,
  `smoke-bootstrap-retry`, `smoke-shipped-voice`,
  `smoke-multidev-resolution`, `smoke-self-adopt-skip`.

### Changed

- **Cross-platform home directory** moved from `~/.local/cairn/` to
  `~/.cairn/` on every platform. Single hard cutover — no migration
  code, no fallback shim, no XDG environment variable. Touches
  trace dir, mirror checkout, models cache, and the related docs.
- **TSK id format** is now `TSK-<slug>-<7-hex>` where the suffix is
  the first 7 hex characters of `sha256(slug + crypto.randomUUID())`.
  Slug capped at 4 words. No counter file, no rollover. Hard
  cutover — citation regex tightened to the new format only;
  pre-cutover task dirs are deleted by the operator.
- **Statusline shim install path** now uses
  `basename(CLAUDE_PLUGIN_ROOT)` instead of a hardcoded
  `isaacriehm-cairn` slug. Statusline command and the
  `cairn-adopt` Step 1.5 wire-detection both glob
  `~/.claude/plugins/cache/*/.active-version-path` so plugin slug
  renames don't break the statusline.
- **`bootstrap-guard.ts` remediation** rewritten — replaces
  `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" join` with an
  `cairn_bootstrap_retry` MCP tool reference + a Claude Code
  restart hint. Plugin spec §11 honored at the failure path.
  `cairn-attention` Step 0 calls the new MCP tool on
  `BOOTSTRAP_REQUIRED`; explicitly bans `cli.mjs` and `cairn join`
  references in chat output.
- **Operator-personal voice removed from shipped skills.** Stripped
  the `caveman-ultra style for chat replies` bullet from
  `cairn-adopt/SKILL.md`, `cairn-attention/SKILL.md`,
  `cairn-direction/SKILL.md`, and `agents/reviewer.md`. Replaced
  with a uniform pointer to `.cairn/ground/brand/voice.md`
  (already loaded by `spec-delta` on SessionStart). Adopters now
  get neutral skills regardless of operator's local profile.
- **Tightened init-pipeline typing.** `PhaseOutputs` is now a typed
  interface mapping each `PhaseId` to its concrete result type.
  Three result types (`IngestionResult`,
  `IngestSourceCommentsResultPersisted`, `RunRulesMergeResult`)
  split into discriminated unions (Run + Skipped variants) so the
  self-adopt skip path is type-safe by construction. All 21
  `state.outputs[…] as <Type>` casts dropped; zero
  `as unknown as` casts in `packages/cairn-core/src/`. Two
  duration-stamp mutation blocks rewritten via `Object.assign` +
  `in` guard.
- **Direction skill pivot detection.** `cairn-direction` Step 0.5
  surfaces an inline A/B/C (`complete first` / `pivot — archive
  current task` / `keep current, new as sub-task`) when the
  operator's prompt diverges from the active task's title noun-set
  by ≥50%. Closes the "tasks never complete" dead-end.
- **Workspace grew to five packages** with the addition of
  `cairn-state` (ground-state schemas + low-level I/O). Smoke gate
  grew from 27 to 38; typed MCP tool count grew from 25 to 29.
  README, CLAUDE.md, ARCHITECTURE.md, and the user-facing reference
  reconciled.

### Fixed

- **Task lifecycle dead-end.** Tasks now graduate through phases;
  the GC `completion-integrity` pass is no longer dead code.
  Direction skill no longer skips forever after the first task.
- **README + CLAUDE.md drift** reconciled (5 packages, 38-smoke
  gate, 29 typed MCP tools, 5 hooks).
- **WSL+PowerShell git-permission failure** auto-resolved on
  adoption; smoke locks the contract.
- **Pre-commit + commit-msg hook resolution** verified to prefer
  `.cli-path` before `command -v cairn`; smoke locks the contract.

## [0.7.3] — 2026-05-09

### Fixed

- **Hook commands now survive `${CLAUDE_PLUGIN_ROOT}` paths with
  spaces.** When the plugin is installed via a local marketplace
  pointing at a path that contains spaces, every hook in
  `hooks/hooks.json` failed at the shell with
  `Cannot find module '<path-prefix-up-to-first-space>'`. Wrapped
  the path expansion in `"…"` across the seven hook commands, the
  `check-layout.mjs` build validator, the `smoke-plugin-layout`
  smoke, the `cairn join` `.cli-path` writer (which is `eval`'d by
  the per-clone pre-commit hook), and the three example hook entries
  in `docs/PLUGIN_ARCHITECTURE.md`.

### Changed

- **MCP init surface collapsed from 15 tools to 2.** The 13
  `cairn_init_phase_<id>` per-phase tools and the separate
  `cairn_init_phases_8_9_10_parallel` tool were folded into the
  umbrella `cairn_init_run({ phase, answer? })`. Phase 8
  (`8-docs-ingest`) internally fans out to phases 8/9/10 in parallel
  and advances to `11-baseline`; the cairn-adopt skill no longer
  needs a special-case branch for the parallel gate. Cuts ~5k tokens
  of MCP listing bloat.

  **Breaking** for any external script calling
  `cairn_init_phase_<id>` or `cairn_init_phases_8_9_10_parallel`
  directly. Migration: call `cairn_init_run({ phase: "<id>" })`
  instead.

- **MCP tool count** in README, ARCHITECTURE, MCP_SURFACE, and
  the user-facing reference guide updated to reflect the new 25-tool
  surface.

## [0.7.1] — 2026-05-09

### Fixed

- **Hook payloads now declare the correct `hookEventName`.** Claude
  Code 2.1+ validates that a hook's stdout
  `hookSpecificOutput.hookEventName` matches the event the hook was
  invoked for, and rejects mismatches with `Hook returned incorrect
  event name`. The shared `emitShapeB` helper hardcoded
  `"PostToolUse"` for every caller, so the SessionStart adoption
  banner — and any other Shape-B output routed through `payload.ts`
  from a non-PostToolUse hook — was silently dropped by the runtime.
  `emitShapeB` now takes a typed `hookEventName` parameter; the five
  shared-helper callers (`session-start` ×2, `session-end`,
  `write-guardian`, `read-enricher`) pass the correct event name.

### Changed

- **Stripped private-doc back-references from source comments.**
  Pre-public-release sweep removed 9 references to operator-private
  planning artifacts (`PRIMER.md §N`, `INTEGRATION_PLAN.md §N`, the
  v0.5.0 deferred-work plan) across 8 source / smoke-script files.
  Comment content is unchanged in substance; only the dangling
  pointers are gone.

### Added

- **User-facing guide** at `docs/guide/`. Six prose docs walking an
  experienced developer through Cairn from first install through
  daily use, decision design, and team enforcement: `concepts.md`,
  `daily-flow.md`, `adoption.md`, `decisions.md`, `multi-dev.md`,
  `reference.md`. README documentation table split into "User guide"
  and "Technical specs" sections.

## [0.7.0] — 2026-05-07

### Added

- **Staged docs ingestion.** Phase 6 now runs an explicit marker
  scan, a file-level Haiku filter, and a section-level Haiku batch
  classifier before emitting DEC drafts to `_inbox/`. Cuts adoption
  wall on busy monorepos from hours to roughly a minute and
  collapses the noisy ledger to a curated draft set the operator
  triages via `cairn attention`.
- **Three MCP tools for unpromoted topic-index candidates.**
  - `cairn_search_candidates({ query?, scope?, kind?, limit? })` —
    queries entries with `dec_id IS NULL`; mirrors
    `cairn_decisions_in_scope` shape.
  - `cairn_propose_decision({ slug, title?, kind? })` — promotes a
    candidate to a DEC draft. Idempotent on slug, drift-checked
    against the topic-index `content_hash`, refuses rejected slugs.
    Response wording instructs the AI not to enforce until
    operator-accepted.
  - `cairn_reject_candidate({ slug, reason })` — appends to
    `.cairn/ground/_rejected.yaml`, dedupe-by-slug.
- **Read-enrich hook surfaces unpromoted candidates** via an O(1)
  `file-candidates-map.yaml` lookup (emitted by phase 5b). Files
  with ≥1 candidate get a one-line notice prompting
  `cairn_propose_decision` when a passage states an active rule.
- **`cairn tag --insert-marker <pattern> <path>`** — operator-driven
  retro-tag CLI. Git-aware (refuses dirty tree without `--force`),
  impact circuit breaker (skips files where the pattern hits more
  than 30% of lines without `--force-pattern`), 3-line idempotency
  lookahead. Deterministic, 0 Haiku.
- **Phase 7b regex pre-filter.** Essay-class block comments only
  reach the batch classifier when they contain imperative
  conventions (MUST / SHALL / NEVER / INVARIANT / @invariant /
  @rule / @decision / @cairn:decision / @cairn:rule). Marker tags
  always emit regardless.
- **`smoke:llm-prompt-eval`** — opt-in real-Haiku smoke against
  three inline fixtures (ADR / UAT log / research) that pins the
  Stage-1 file-purpose prompt's behavior. Not part of the standard
  smoke gate; run when touching the prompt or upgrading the model.

### Fixed

- **Title extraction.** `firstLineFallback` now strips C-family
  markers, JSDoc continuations, line-comment markers, Python
  triple-quote, Ruby `=begin`/`=end`, Lua `--[[`/`--]]`, Haskell
  `{-`/`-}`, OCaml `(*`/`*)`, markdown headings, and horizontal-rule
  separators. Skips `@tag` annotations and pure boundary lines.
  Single shared implementation in `sot-emit.ts`; removed the
  divergent copy from `ingest-docs.ts`.
- **Confidence scorer returned "low" universally.** `bulk-accept`
  now falls back to the full body when the `## Source comment` /
  `## Constraint` sections are missing (phase-7b drafts emit
  verbatim essays). Stamping is gated so a re-run with a different
  threshold doesn't overwrite earlier scores on drafts that already
  carry a valid confidence value.
- **Web UI "accept high-confidence" silently mutated drafts.** The
  action now runs a dry-run preview, surfaces the high/medium/low
  distribution + promote count via `window.confirm`, and only
  commits if the operator confirms. Counters skip dry runs.
- **Subagent token leak.** `init/mapper-parallel.ts` and
  `mcp/history/summarizer.ts` now pass `isolateAmbientContext:
  true` so the subprocess doesn't ingest the operator's CLAUDE.md
  hierarchy and plugin/MCP context per call.
- **Lens ghost text clipped long / multi-line titles.** Inline and
  replace decorations now carry a `hoverMessage` with the full
  untruncated title (works around microsoft/vscode#63600).
- **Phase 5b judge timeout storms.** `TIMEOUT_MS` 8000→45000 ms +
  circuit breaker (5 consecutive timeouts → bail; auth/quota
  errors trip immediately). Resolver also runs a worker pool of
  N=5 concurrent judges with `onProgress` callbacks for live
  statusline updates.
- **Walker pollution from agent worktrees.** `topic-index/walk.ts`
  now skips `.claude/` from the doc walk; `.claude/rules/` stays
  covered by the dedicated `walkRulesDir`.
- **Progress writer pinned at 100%.** `parallel-678.ts` no longer
  emits `batch = total` from the first callback; an external
  counter increments per completed entry.
- **Cold-start UX.** `cairn init` ends with a four-line summary
  (rules verified / drafts found / candidates indexed / next
  action). The `cairn-adopt` skill registry also got a
  `5b-topic-index` row with realistic ETAs and a live-progress
  context line.

### Migration

Hard cutover. Operators with v0.6.x adopted projects:

```
rm -rf .cairn/
cairn init
```

The new schema (`marker_kind` on ProseBlock, `_rejected.yaml`,
`file-candidates-map.yaml`, phase-6 drafts in `_inbox/`) is not
migration-compatible. Back up hand-edited DECs first.

## [0.6.0] — 2026-05-07

### Added

- **`cairn attention undo` reverses Tier-3 fresh DEC/INV creation +
  augments-sibling emission.** Both kinds previously returned
  `not-supported` and required hand-surgery. The reversal now deletes
  the freshly-emitted entity file, unbinds it from `sot-bindings`,
  drops its `sot-cache` entry, clears the topic-index reference,
  refreshes the affected ledger, and restores the original prose at
  the recorded source offsets. All mutations run under
  `withWriteLock`. Augments rollback also trims the source's
  double-cite line back to the existing-id cite (the augmented entity
  stays referenced). Source-restore lands FIRST so a partial failure
  leaves the operator with original prose + an entity to re-cite
  manually rather than an orphaned cite pointing at a deleted DEC.
  Plan §11.7 — closes the v0.6 audit item from the v0.5.0 deferred
  file.
- **Layer D apply-phase consent gates.** `cairn fix align` now refuses
  to run an apply phase without two operator-explicit signals:
  - **Dry-run sentinel.** `--dry-run` writes
    `.cairn/state/fix-align-dryrun.json` carrying `ts`,
    `repo_head_sha`, and `args_hash` (sha256 over the normalized
    flag set). The next non-dry-run invocation must find a sentinel
    that is fresh (within 30 minutes), points at the current `git
    rev-parse HEAD`, and matches the same flag set. Mismatch reports
    `missing` / `stale` / `head-drifted` / `args-drifted` and aborts
    before any Haiku call.
  - **Dirty-tree guard.** Apply scans `git status --porcelain
    --untracked-files=all` for paths intersecting the include globs.
    Hits abort with a preview of the first five dirty paths.
  - **`--force` flag** bypasses both gates for CI / scripted contexts.
  Plan §4.4.
- **Lens `⚑` staleness flag.** The decoration provider renders a
  small amber `⚑` glyph in the left gutter beside any §DEC / §INV
  token whose id is referenced by a pending entry in
  `.cairn/staleness/log.jsonl`. Per-line dedup so multiple cite
  tokens on the same line emit one flag. The lens file watcher fires
  on `staleness/log.jsonl` changes so the flag clears in real-time
  when GC drains a drift entry. Plan §10.4.
- **Append-time GC + write-lock for the Layer A audit log.**
  `appendAlignUndoEntry` and `pruneAlignUndoLog` now wrap their write
  cycles in `withWriteLock` — two concurrent Layer A invocations can
  no longer corrupt JSONL line boundaries. When the log is at or
  above 256 lines, the append path reads + filters entries older
  than 7 days before writing back; operators who never run `cairn
  attention undo` no longer accumulate one line per Layer A
  auto-resolution forever.
- **`writeFileSafe` helper** in `cairn-core/src/fs.ts` —
  `mkdirSync(dirname(path), { recursive: true }) + writeFileSync`
  collapsed into a single call. Applied to 11 sites across 10 files
  (ground writers + ad-hoc writers in init / mcp tools).
- **`parseFrontmatterRecord` helper** in
  `cairn-core/src/ground/frontmatter.ts` — replaces three identical
  10-line YAML-frontmatter parse blocks in `resolve-attention.ts`
  and the two private `parseFrontmatter` functions in
  `attention/bulk-accept.ts` and `attention/serve/api.ts`.

### Changed

- **`sot_kind` / `sot_path` / `sot_content_hash` are now required**
  on `DecisionFrontmatter` and `InvariantFrontmatter`. The fields
  shipped as `.optional()` in v0.5.0 to keep v0.4.x ledgers parseable
  during the field rollout; required is the belt-and-suspenders flip
  that catches any drift sooner.
  `cairn_record_decision` was the lone DEC writer that still emitted
  drafts without the SoT trio — it now stamps `sot_kind: "ledger"` /
  `sot_path: "ledger"` / `sot_content_hash: bodyContentHash(body)` on
  every captured DEC. Other writers (Layer A fresh DEC, conflict
  merge, init phases 5b / 6 / 7b / 7c) already stamped the fields.
- **`tools/index.ts` registry typed `ToolDef<never>[]`** instead of
  `ToolDef<unknown>[]` with 25 cast sites — the contravariant
  parameter position makes `never` the safe upper-bound for a
  registry that owns no input schema. Casts collapse to zero.
- **`.nullable().optional()` → `.nullish()`** across the 14 schema
  sites (cairn-core/src/ground/schemas.ts + the align-undo log
  schema). Functionally identical, less noise.
- **Two `await import("node:fs")` lazy loads → static imports** in
  drain.ts and one rules-merge ingest path. The lazy loads predated
  the ESM toolchain settling and were no longer pulling weight.

### Fixed

- **Layer A augments-undo entries now carry `primary_kind`.** Tier-3
  creation already stamped it; the augments path was missing it,
  forcing the reversal pipeline to derive the kind from the id
  prefix. Both paths now store the kind explicitly; the prefix-based
  derivation remains as a fallback for entries written before this
  commit.
- **Dead `emptySot*` / `emptyTopicIndex` fallback guards removed**
  from `sot-emit`, `resolve-attention`, `sot-align`. The read helpers
  already return the empty sentinel on missing or invalid file, so
  the wrapper guards were unreachable.
- **Three `as unknown as` cast sites cleared.** `z.enum` now gets
  `PHASE_IDS` directly; `validateMapperOutput` uses a narrow optional
  cast; `readLedgerSafely` drops the generic `<T>` for typed
  overloads.

## [0.5.0] — 2026-05-06

### Added

- **SoT (source-of-truth) schema fields on every DEC + INV.** Each
  entity carries `sot_kind: "ledger" | "path"`, `sot_path` (the
  external location it was captured from, or the literal `"ledger"`),
  and `sot_content_hash: <sha256>` of its body. The new
  `.cairn/ground/sot-bindings.yaml` (forward + reverse path → id maps),
  `.cairn/ground/sot-cache.yaml` (pre-tokenized DEC bodies for the
  Layer A Jaccard pre-filter), `.cairn/ground/topic-index.yaml`
  (content-fingerprint → DEC slug map), and `.cairn/ground/anchor-map.yaml`
  are the on-disk surfaces that make this provenance addressable.
  Schema fields ship as `.optional()` for v0.5.0 so existing v0.4.x
  ledgers stay parseable. The optional → required flip lands in v0.6.
- **Layer A — live SoT alignment hook.** New PostToolUse Write/Edit
  hook reads each freshly-typed prose block, runs Tier 1 (deterministic
  cite via topic-index), Tier 2 (two-pass Haiku dedup judge against
  sot-cache candidates), and Tier 3 (fresh DEC creation when no
  candidate matches). Source files get strip-replaced with bare
  `// §DEC-NNNN` cites; ambiguous Pass-2 verdicts spill to
  `.cairn/ground/alignment-pending/<slug>.md` for operator triage via
  `cairn attention`. Verdict cache scoped on `(prose, candidate id,
  body hash)` keys so DEC body edits invalidate cached verdicts. New
  `smoke-sot-align` covers all four pipeline stages.
- **Layer B — git pre-commit drift log.** A new
  `.cairn/git-hooks/pre-commit` shell hook (different mechanism from
  Claude Code PostToolUse) inspects each staged blob, runs the same
  Tier 1 + Tier 2/3 candidate match against sot-cache, and appends
  to `.cairn/staleness/log.jsonl` for any block that lands without a
  cite. Shell-level invocation catches commits made outside Claude
  Code. Markdown / canonical doc files are skipped (auto-cite never
  rewrites the operator's narrative). New `smoke-layer-b-precommit`.
- **Layer C — SessionStart drain.** New `cairn_align_drain` MCP tool
  + SessionStart hook that catches up alignment work that fired
  outside an active session (off-session edits, pre-commit drift
  entries, multi-dev fan-in). Recomputes candidate scope from fresh
  body reads instead of cached snapshots so cross-session edits
  re-judge correctly. New `smoke-layer-c-sessionstart-drain`.
- **Layer D — `cairn fix align` retroactive sweep.** Full-repo
  Haiku-judge pass over every prose block × every DEC for projects
  adopted before Layer A landed. Pre-flight `--dry-run` returns the
  cost estimate; `--max-cost <tokens>` aborts if the estimate exceeds
  budget (default 500k). `--include` / `--exclude` glob flags scope
  the sweep. `--no-creation` consolidates to existing DECs only.
  New `smoke-fix-align`.
- **Phase 5b topic-index — cross-source dedup pre-pass.** Walks all
  doc / CLAUDE.md / AGENTS.md / source-comment candidates before
  phases 6 / 7b / 7c run, normalizes content into 12-char content
  fingerprints, and writes `topic-index.yaml`. Phases 6 / 7b / 7c
  consult the index to dedup-by-topic so the same constraint
  surfacing in three sources emits one DEC, not three. Topic-pair
  ambiguity routes through a Haiku judge with isolated ambient
  context and a safe-default `"different"` fallback. New
  `smoke-topic-index`.
- **Phase 6 verbatim doc ingest.** New dynamic doc walk replaces the
  hard-coded README + ARCHITECTURE allowlist. Walks all canonical
  docs, classifies each block as decision / invariant / context, and
  emits ledger entries citing the source path.
- **Phase 7b ledger source-comments rewrite.** Source-comment essays
  no longer auto-emit a DEC per essay — they cite-existing when the
  topic-index shows the constraint already lives in the ledger. New
  comments still emit ledger entries. The strip-replace path that
  was already removing inline comment essays continues to fire on
  accept.
- **Phase 7c rules-merge rewrite + contradiction judge.** CLAUDE.md
  / AGENTS.md ingest now checks the topic-index for cite-existing,
  and a new contradiction-detection Haiku call (capped 1500-char
  prose to prevent prompt injection from operator content) compares
  freshly captured rules against existing ledger entries. Pairs that
  judge as contradictory write a conflict file at
  `.cairn/ground/conflicts/<a-id>__<b-id>.md` instead of accepting
  silently. The init pipeline's previously-parallel phases 6 / 7b /
  7c are now sequentialized — they share the topic-index +
  sot-cache files, so concurrent writes were racing on disk.
- **Conflicts queue + `cairn_resolve_attention` conflict path.** New
  `kind: "conflict"` resolves the four operator-facing choices
  (a: keep A, b: keep B, c: merge into a fresh DEC, d: archive
  both). Each choice supersedes / archives the losing entity, drops
  the loser from `sot-bindings` + `sot-cache` so Layer A's Tier-2
  pre-filter doesn't keep picking the now-superseded id, and emits
  an `orphan_path` drift event whenever the loser was path-SoT — the
  losing-side prose still lives at its original `sot_path` and the
  drift event is the operator-facing surface to recover it (re-cite
  the winner manually, promote it to a fresh DEC, or delete the
  orphan paragraph). Merge path also binds + caches the freshly
  emitted merged entity so Layer A picks it up on the next
  PostToolUse without waiting for SessionStart drain. Cairn-attention
  skill renders the four-option surface inline. New
  `smoke-conflicts-queue` covers all four branches and asserts
  post-resolution sot-state invariants.
- **`cairn attention undo` + Layer A audit log.** Every Layer A
  auto-resolution (Tier 1 cite, Tier 2 same / augments cite, Tier 3
  fresh DEC creation) appends one line to
  `.cairn/state/align-undo-log.jsonl` with the strip-replace metadata
  needed to reverse it. `cairn attention undo [--since <duration>]`
  reverts recent entries (Tier 1 + Tier 2 cites supported in v0.5.0;
  tier3-creation + augments-sibling reversal returns
  `not-supported` and is queued for v0.6). Log self-prunes on undo
  for idempotent re-runs against the same window. New
  `smoke-attention-undo`.
- **Statusline event queue.** Bounded ring buffer at
  `.cairn/state/statusline-events.json` (cap 32) carries
  PostToolUse-emitted alignment blips so the statusline reader can
  surface ephemeral feedback (`⬡ aligned DEC-NNNN`) without
  cluttering the longer-lived ground state.
- **Lens — sot-aware body resolution.** The VS Code / Cursor
  extension's hover provider now follows `sot_kind` / `sot_path`
  when rendering DEC + INV bodies. Path-SoT entities surface their
  external source path; ledger-SoT entities render the ledger entry
  body directly. Gracefully handles missing `sot-cache.yaml` /
  `sot-bindings.yaml` (pre-migration v0.4.x repos). New
  `smoke-sot-body`.
### Changed

- **Init phases 6 / 7b / 7c are now sequential.** Previously
  `cairn_init_phases_678_parallel` ran them concurrently. Phase 5b's
  topic-index + the new sot-cache mean phases 6 / 7b / 7c share
  on-disk state; sequencing them eliminates concurrent-write races.
  The MCP tool keeps the `parallel` name for backward continuity
  but its body now `await`s each phase in order.

### Fixed

- **Layer A verdict cache keyed on stale body hash.** The Tier 2
  pre-filter stored verdicts under
  `(prose, candidate id, candidate body_hash)` with `body_hash`
  pulled from the sot-cache snapshot in `cand.body_hash`. Sot-cache
  is not refreshed when the operator edits a DEC body directly, so
  the cache could return a "same" verdict made against an old body
  while Haiku judged the fresh body. Fixed by computing the hash from
  `candBody` (already read off disk in the same loop) so the scope
  invalidates immediately on body edit.
- **Conflict resolution left dangling sot-bindings + sot-cache
  entries.** The four-branch resolver rebuilt only the DEC / INV
  ledgers; superseded / archived losers retained their entries in
  `sot-bindings.yaml` and `sot-cache.yaml`. Layer A's pre-filter
  walks every cache entry with no supersede check, so it could pick
  a now-superseded loser as a Tier-2 candidate, and phase 5b's path
  walks could loop on a binding pointing to a superseded id. Fixed
  by unbinding losers from sot-bindings + dropping their sot-cache
  entries in all three branches (supersede / merge / archive).
  `mergeConflict` now also binds + caches the merged entity so Layer
  A picks it up on the next PostToolUse without waiting for
  SessionStart drain.

## [0.4.2] — 2026-05-06

### Fixed

- **Lazy bootstrap on first MCP write call.** Multi-dev gap: when a
  teammate cloned a Cairn-adopted repo and installed the plugin
  mid-session via `/plugin install`, the plugin's SessionStart hook
  never fired for that session — `core.hooksPath` stayed unset, hooks
  remained unwired, but Cairn MCP tools became immediately available.
  The first write tool call refused with `BOOTSTRAP_REQUIRED` and the
  operator had to manually `cairn join` (or restart Claude Code).
  `requireBootstrap` now auto-runs `cairn join` synchronously when
  `core.hooksPath` is unset; the call short-circuits to a normal pass
  on success and surfaces a `BOOTSTRAP_REQUIRED` envelope with
  per-step `failed_steps` detail only when the auto-join itself
  errored. Idempotent + local-clone-only state — plugin install is
  implicit consent for the wiring.

## [0.4.1] — 2026-05-06

### Fixed

- **Seed walker no longer copies files at the `templates/` root.**
  Pre-v0.2.0 cairn shipped a `templates/README.md` documentation
  file (about the templates dir itself) by accident. The seed
  walker walked `templates/` recursively and faithfully copied
  every file preserving relative paths, which meant a stray
  `templates/README.md` landed at `<repoRoot>/README.md` and
  **clobbered the project's actual README** during `cairn init`.
  The offending file was removed in v0.2.0 but the walker stayed
  permissive — any future stray top-level template would have hit
  the same trap. The walker now only descends into a fixed
  allowlist of top-level entries (`.cairn`, `.archive`,
  `.claude`, `.github`); anything at the templates root is ignored.

  Recovery for projects adopted before this fix: restore the
  pre-cairn README from git history, e.g.
  `git checkout <pre-cairn-commit> -- README.md` followed by a
  fresh commit. The clobbered content is the small `templates/`
  doc-meta paragraph starting with
  ``# `templates/` — files the init script copies into adopted projects``;
  if your README still starts with that line, it was overwritten.

## [0.4.0] — 2026-05-06

### Added

- **Live adoption-progress heartbeat.** Phases 3-mapper, 6-docs-ingest,
  7b-source-comments, and 7c-rules-merge write
  `.cairn/init/progress.json` after every batch / module / doc /
  section. The statusline reader gains a highest-priority branch
  rendering `⬡ cairn ⏳ adopt <phase> X/Y (P%) ~Nm` with extrapolated
  ETA so the operator isn't staring at a frozen turn during the long
  ingestion phases. The other init phases also emit a coarse
  `batch: 1, total: 1` heartbeat on entry so the badge reflects the
  current phase id all the way through. New
  `smoke-init-progress-heartbeat` covers write/read/clear + format
  priority. Plugin cache wires the new `cairn-statusline-setup` shim
  via `cairn-adopt` Step 1.5.
- **`cairn_init_phases_678_parallel` MCP tool.** Runs phases
  6-docs-ingest, 7b-source-comments, and 7c-rules-merge concurrently
  in one MCP call. Pre-scans existing DEC + INV ids and threads
  shared `Set<string>`s through all three so id allocations don't
  collide on disk. Skill prefers this when
  `state.currentPhase === "6-docs-ingest"`; per-phase sequential
  tools stay registered as a fallback path.
- **DEC near-duplicate detector.** New `cairn_attention_dedup` MCP
  tool clusters drafts in `_inbox/` by token-Jaccard similarity
  (no LLM, ~50 ms for hundreds of drafts) at two tiers: definite
  (≥ 0.5) and potential (0.4..0.5). cairn-attention skill renders a
  cluster section before per-item triage with a one-shot
  `keep / keep-all-distinct / reject-cluster` choice.
- **DEC strip-replace on accept.** `cairn_resolve_attention` accept
  path replaces the originating source-comment essay with
  `// §DEC-NNNN` (mirroring the §INV strip pass that 7b runs at
  adoption). Bulk-accept extends the pattern, surfacing aggregate
  `sourceStripFilesModified` / `sourceStripItemsApplied` counts.
- **`cairn attention restore` + `cairn_attention_restore` MCP tool.**
  Move a previously rejected or accepted DEC back to draft state in
  `_inbox/<id>.draft.md` so the operator can re-evaluate via the
  normal A/B/C flow. `cairn_resolve_attention` auto-restores
  transparently when the caller passes a rejected or already-accepted
  id, so flipping a rejected DEC takes one MCP call instead of three.
- **Retroactive `cairn fix` subcommands.** `brand` re-runs the Phase 5
  Haiku brand-derive call against the on-disk mapper output and
  rewrites the four brand files. `dec-strip` replays
  source-comment strip-replace for accepted DECs whose original prose
  is still in source (idempotent — re-runs report
  `already-stripped`); content-search retry recovers from offset
  drift caused by earlier INV / DEC strips in the same file.
  `gitignore` rewrites `.cairn/.gitignore` from the bundled template
  and `git rm --cached`s newly-ignored paths. `scrub-cache` wipes
  `.cairn/cache/haiku/` for re-derivation under v0.4.0's isolated
  transport. `claude-rules` writes `.claude/rules/cairn.md` so
  teammates whose Claude Code lacks the plugin still see install
  instructions on session start. All subcommands ship `--dry-run`.
- **`cairn baseline [--force]` CLI.** Re-runs the synthetic-diff
  sensor sweep post-adoption. `--force` bypasses
  `BASELINE_SKIP_IDS` so post-init sensors that need ground state
  (decision-assertions, invariant-suite, attestation-cross-check, …)
  finally execute.
- **`.claude/rules/cairn.md` ships in the seed.** Claude Code
  auto-loads `.claude/rules/*.md` regardless of plugin install state.
  Teammates without the plugin now see install instructions on the
  first reply.
- **First-clone welcome banner.** When SessionStart's bootstrap path
  runs `cairn join` and succeeds for the first time on this clone,
  it now returns a "first session on this clone" banner that
  primes Claude to surface a one-line ground-state summary even on
  casual greetings ("hi"). Subsequent sessions skip it because
  `state.hooksPathSet` is true.
- **Phase 7b walk + classifications spillover.** Heavy walk +
  per-block classifications now persist to
  `.cairn/init/source-comments-walk.json`; only a lightweight
  projection (counts, ledger paths, kindCounts) lives on
  `init-state.json` so the MCP transport stays skinny on real-world
  adoptions.
- **Phase 7b stamps `capture_confidence` at write time** when project
  globs + pilot are passed. `cairn attention bulk-accept` becomes an
  O(1) file move instead of a re-score sweep.
- **Phase orchestrator stamps `duration_ms`** on every phase output
  (was only Phase 3-mapper before). Unblocks ETA self-audit against
  the cairn-adopt SKILL.md ETA registry.
- **Haiku response cache.** Opt-in via
  `runClaude({ cacheable: true, repoRoot })`. 30-day TTL keyed on
  `tier|system|prompt|jsonSchema`. Storage at
  `.cairn/cache/haiku/<sha>.json`. Brand-derive + 7b classify both
  opt in. Skips identical re-runs without burning the operator's
  coding-plan quota. Cache dir added to `.cairn/.gitignore`.

### Changed

- **Phase 7b BATCH_SIZE 20 → 10.** Halves Haiku output per batch and
  drops the validation-target failure rate to ~0%. Round count
  doubles (61 → ~122) but parallelism unchanged → wall-clock 7b
  grows modestly (~22.6 min → ~25 min) — acceptable for ~0% loss.
- **Phase 7b `classifyOneBatchWithRetry`.** On `AbortError` /
  `error_kind: "timeout"`, splits the batch in half and re-issues
  both halves with the full per-batch timeout. Defense-in-depth on
  top of the BATCH_SIZE reduction.
- **Brand-derive 60 s timeout + 2-attempt retry.** Replaces the
  prior 30 s single-shot path. Falls back to mechanical defaults
  only after both attempts fail; `applied.warnings[]` surfaces a
  hint to re-run `cairn fix brand`.
- **Tighten `.cairn/.gitignore`.** Adds `init-state.json`, `init/`,
  `staleness/`, `backups/`, and `cache/` to the bundled template
  alongside the existing entries (sessions/, events/, locks,
  .attested-commits, .cli-path). Run `cairn fix gitignore` to
  migrate older adoptions.

### Fixed

- **Mid-init resumability.** Phases now `clearProgress` on every
  exit (success and error) so a stale `progress.json` doesn't bleed
  into the next phase's render.
- **DEC strip-replace dirty-file gate.** Phase 7b's INV strip pass
  mutates source files inline, so by the time a DEC accept fires
  the same file is dirty against HEAD. `runDecSourceStrip` now
  passes `dirtyDecisions: { [block.file]: "overwrite" }` so the
  dirty check doesn't bail. Mirrors Phase 7b's own
  dirtyDecisions map.
- **DEC strip surfaces real skip reasons.** Previously returned
  `"unknown"` whenever `applyStripReplace` returned 0 items applied
  without throwing; now surfaces `range-mismatch` /
  `missing-file` / `overlap` / `dirty-skipped`. On `range-mismatch`
  specifically, retries with a content-search of `block.raw` in
  the current file to recover from offset drift.
- **Idempotent `cairn fix dec-strip` re-runs.** `runDecSourceStrip`
  now checks for the bare cite (`// §DEC-NNNN` / `# §DEC-NNNN`) in
  the target file before issuing the strip; if present it returns
  `attempted: false` with reason `already-stripped`. CLI surfaces
  `· DEC-NNNN — already stripped (no-op)` separately from real
  failures.
- **Runner SIGTERM → `error_kind: "timeout"`.** Exit code 143
  and `AbortError` now classify as `timeout` instead of `other` so
  trace observability distinguishes timeouts from generic failures.
  `runner.ts` also wraps the AbortError path in a single
  `settled` guard so the trace doesn't double-fire on abort.
- **Multi-dev first-clone session.** When a teammate clones a
  Cairn-adopted repo and opens Claude Code for the first time,
  SessionStart's bootstrap path now returns a banner so a casual
  "hi" gets an explicit Cairn acknowledgment rather than a generic
  "Hey what's up?" reply.
- **`cairn fix scrub-cache` ESM compatibility.** Crashed under Node
  24 with `ERR_AMBIGUOUS_MODULE_SYNTAX` because of an inline
  `require()` call inside an ESM async function. Hoisted `rmSync`
  to a top-level static import.

### Security

- **Haiku subprocess ambient-context isolation.** Cairn invokes the
  `claude` subprocess for Haiku-tier classifications (brand-derive,
  source-comments classify, docs-ingest, rules-merge,
  mapper-merge). Operator caught real-world data leakage in
  `.cairn/cache/haiku/<sha>.json`: brand text referenced operator's
  organization-level identifiers from the user-global
  `~/.claude/CLAUDE.md` that are NOT in the project repo. The
  Claude Code subprocess auto-loads the user-global CLAUDE.md plus
  the project-hierarchy CLAUDE.md ancestor chain, contributing
  ~76k tokens of ambient context per Haiku call. Resolution: new
  `RunClaudeOptions.isolateAmbientContext` flag. When true, the
  subprocess runs from `os.tmpdir()` (so the CLAUDE.md ancestor
  chain doesn't auto-load) and passes
  `--setting-sources project,local --tools "" --disable-slash-commands`.
  Verified: 76k → ~700 input tokens (99% reduction); a probe asking
  Haiku to list known organizations returns an empty array.
  Opt-in at every Cairn-internal Haiku site.

### Migration notes for projects adopted under v0.3.x

```bash
# 1. Wipe the contaminated Haiku cache
cairn fix scrub-cache

# 2. Tighten .cairn/.gitignore + untrack newly-ignored paths
cairn fix gitignore --dry-run    # review first
cairn fix gitignore

# 3. Add .claude/rules/cairn.md so teammates without the plugin
#    still see install instructions on session start
cairn fix claude-rules

# 4. Re-derive brand under the isolated transport
cairn fix brand --dry-run
cairn fix brand

# 5. Replay strip-replace for accepted source-comment DECs that
#    didn't get the inline cite on first accept
cairn fix dec-strip --dry-run
cairn fix dec-strip
```

## [0.3.8] — 2026-05-06

### Fixed

- **Statusline noun mislabeling.** The `attention_count > 0`
  branch rendered `⚑ N drafts` even though `attention_count`
  rolls up DEC drafts + baseline sensor findings + drift events
  (not drafts only). On a fresh adoption with 505 drafts + 486
  baseline findings + 0 drift, the badge read `⚑ 991 drafts`
  which was off by 486 from the real draft count. Renders as
  `⚑ N pending` now; the cairn-attention skill renders the
  per-kind breakdown when the operator engages.
- **`smoke-status-line` Step 5 + Step 9** updated to assert the
  new "pending" noun.

## [0.3.7] — 2026-05-06

### Added

- **`cairn_bulk_accept_attention` MCP tool + `cairn attention
  bulk-accept` CLI subcommand.** Phase 7b on a busy monorepo
  produces hundreds of DEC drafts and invariants — interactive
  triage one-at-a-time is hours of clicking. The bulk tool scores
  every draft + invariant in `.cairn/ground/decisions/_inbox/` and
  `.cairn/ground/invariants/` against a confidence heuristic and
  auto-promotes the obvious ones out of the inbox. Distribution on
  a 700-file NestJS+Next monorepo: 12% high / 45% medium / 43% low
  for DEC drafts; 19% / 51% / 30% for invariants. Default
  `threshold: "high"` only auto-accepts the top tier; operator can
  widen to `medium` (≈60% accept) or `low` (effectively all) via
  the CLI dry-run + run flow. Every draft + invariant gets
  `capture_confidence: high|medium|low` stamped in frontmatter so
  subsequent attention surfaces can sort.
- **Confidence heuristic** in `packages/cairn-core/src/attention/scoring.ts`.
  DEC scoring (max 9, ≥7 high / ≥4 medium): file in
  `high_stakes_globs` +3, in pilot module +1, in
  `route_handler_globs` / `dto_globs` +1, prose 80–800 chars +2,
  title 10–80 chars +1, decision-verb tokens +2, JSDoc tags +1.
  Invariant scoring (stricter — false positives become enforcement
  noise): `high_stakes_globs` +3, modal verb +3, reason marker +2,
  prose 50–600 chars +1.
- **cairn-attention skill Step 0.5.** Skill auto-invokes the bulk
  tool before any per-item triage. Surfaces the count summary
  inline; the operator only sees medium / low-confidence drafts in
  the interactive flow.
- **CLI dry-run.** `cairn attention bulk-accept --dry-run
  [--threshold high|medium|low]` prints the score distribution
  without writing — operator previews the trade-off before
  committing.

### Skill registry

- `cairn-adopt` ToolSearch preload now includes
  `cairn_bulk_accept_attention` so the chained `cairn-attention`
  call doesn't pay an extra round-trip on Step 0.5.

### Smoke gate

26 cairn + 3 lens smokes pass on a clean tree (no smoke changes
vs v0.3.6).

## [0.3.6] — 2026-05-06

Re-publish of v0.3.5 with the source tree scrubbed of an
unintentional internal-path example in `hooks/runners/session-start.ts`'s
`findAdoptableChildren` JSDoc. No functional change vs v0.3.5 — same
slim MCP phase responses, same mapper-output spillover, same skinny
state contract.

### Fixed

- **Generic-ized `findAdoptableChildren` source-comment example.**
  The JSDoc and inline example in `packages/cairn-core/src/hooks/runners/session-start.ts`
  used a real-world directory path as a stand-in for "operator opened
  Claude Code in a parent dir with adoptable children". Replaced with
  a neutral `~/projects/parent/` placeholder. Behavior unchanged.

### Smoke gate

26 cairn + 3 lens smokes pass on a clean tree (no smoke changes vs
v0.3.5).

## [0.3.5] — 2026-05-06

Hotfix on top of v0.3.4. Adoption on a real ~700-file
TypeScript monorepo failed at Phase 3-mapper: the MCP response
echoed `state` with the 90KB mapper output inside, which crossed
the MCP transport's spillover-to-file token cap. The cairn-adopt
skill couldn't read `nextPhase` from the spilled file path, gave
up, and spawned a generic-purpose subagent that burned ~5 minutes
flailing — at one point clobbering the on-disk state from 154KB →
191B because the wrapper persisted the empty-outputs echo from a
`missing-prereqs` error path. Operator killed the session.

### Breaking changes

- **`cairn_init_phase_*` MCP tool responses are slim.** Returns now
  `{ status, nextPhase }` / `{ status, question }` / `{ status, error }`
  — the full `state` is no longer echoed. State persists to
  `.cairn/init-state.json`; readers reload from disk on demand. Slim
  responses keep the conversation cache warm and keep every phase's
  result well under the spillover-to-file cap on real monorepos.
- **`cairn_init_resume` returns `{ status, nextPhase, repoRoot }`.**
  Same reason as above — was previously echoing the full state object.
- **`state` parameter on `cairn_init_phase_*` is optional.** Default
  path: tool reads state from disk and only takes an optional
  `answer` field for `needs_input` phases. The cairn-adopt skill no
  longer threads state through tool arguments — the LLM never has
  to stuff a 90KB JSON object into a tool call. Explicit `state`
  arg still works (smoke tests, debug tooling).
- **Phase 3-mapper spills heavy fields to a side file.** The full
  `MapperResult` (including `scope_index.files` and
  `module_proposals`) is written to `.cairn/init/mapper-output.json`.
  `state.outputs["3-mapper"]` carries only the persisted-light
  projection (small globs, pilot pick, key modules, domain summary,
  mechanical sensor list, run metadata). Phase 3b-seed reloads the
  side file on demand to seed `scope-index.yaml`. Other downstream
  phases (4-pilot, 5-brand, 8-baseline) only read the small fields
  and so get them straight from state.
- **State file lingers after terminal phase 12-multidev.** Prior
  versions auto-cleared `.cairn/init-state.json` on the final
  `nextPhase: null`; the cairn-adopt skill needs the persisted
  outputs to source its Step 5 final summary. Cleanup is now a
  manual concern (`cairn doctor` / re-init).

### Fixed

- **Error path no longer clobbers disk state.** `writePhaseState` is
  gated on `result.status !== "error"`. Prior versions persisted
  `result.state` unconditionally — an error path returning the
  input state echo with `outputs: {}` would overwrite a valid 90KB
  mapper run with whatever shape the caller sent in. New smoke step
  `init-mcp-tools / 3d` locks the no-clobber invariant.
- **Adoption no longer escapes into a subagent.** The `cairn-adopt`
  SKILL.md explicitly forbids spawning a subagent to drive the
  pipeline loop — the skill itself is the orchestrator, and nested
  agents lose the operator-facing banner channel and burn tokens on
  a redundant ToolSearch + state re-discovery.
- **`overlay.buildProjectOverlay` accepts the persisted-light
  mapper shape.** `mapperOutput` is now typed as
  `Omit<MapperOutput, "scope_index"> & { scope_index?: … }` — the
  CLI `runInit` path still passes the full output; the MCP path
  passes the lighter projection. Either way, overlay only reads the
  small fields.

### Removed

- `packages/cairn-core/src/hooks/user-prompt-submit.ts` — orphaned
  bin shim. The runner under `hooks/runners/user-prompt-submit.ts`
  is the live implementation, wired via the `cairn hook
  user-prompt-submit` subcommand. The top-level shim was never
  imported and never registered as a plugin entry.

### Smoke gate

26 cairn + 3 lens smokes pass on a clean tree. `init-mcp-tools`
gains four new steps (3b/3c/3d) covering the slim-response
contract, the disk-load default, the missing-state validation, and
the no-clobber-on-error invariant.

### Operator workflow notes

- **Re-adopting a project that hit the v0.3.4 spillover:** delete
  the existing `.cairn/init-state.json` and `.cairn/init/` if
  present, then re-run the cairn-adopt skill. The slim contract
  handles 700-file monorepos cleanly now.
- **Plugin cache resync after upgrade.** `cairn-frontend-claudecode`
  bundle is reproduced verbatim into
  `~/.claude/plugins/cache/isaacriehm-cairn/cairn/0.1.10/`. If the
  CLI version doesn't read 0.3.5, blow that cache dir away and
  re-copy the package as documented in the operator resume.

## [0.3.4] — 2026-05-06

### Added

- **Haiku-derived brand inference** in Phase 5-brand auto-fill. Reads
  the project's `README.md` (first 800 chars) + `AGENTS.md` /
  `CLAUDE.md` tone signals (first 1000 chars each) + the mapper's
  `domain_summary`, then asks Haiku for a strict-JSON brand draft:
  `{ overview, voice, avoid, personas: [{name, description}] }`.
  - On success → `applyBrandAnswers` writes the derived content to
    `brand/overview.md`, `brand/voice.md`, `product/positioning.md`,
    and `product/personas.yaml`.
  - On failure (timeout / malformed JSON / network error) → falls
    back to the mechanical defaults from v0.3.3. Adoption never
    blocks on the inference call.

  Net: a freshly-adopted project now ships with brand drafts grounded
  in the actual codebase + tone signals, not generic boilerplate.
  Operator still flips `status: draft` → `status: accepted` once
  reviewed.

## [0.3.3] — 2026-05-06

### Added

- **Phase 5-brand auto-fill writes every brand/product file with a
  populated draft**, not just `product/positioning.md`. Now writes:
  - `product/positioning.md` ← mapper `domain_summary`
  - `brand/overview.md` ← mapper `domain_summary` (operator can
    diverge from positioning later)
  - `product/personas.yaml` ← `Developers and operators working on
    <project_slug>` (refine when adding consumer-facing personas)
  - `brand/voice.md` ← default voice + avoid profile that points
    operator at `CLAUDE.md` / `AGENTS.md` for tone signals
- **Template overhaul.** Every operator-paced file in
  `.cairn/ground/{brand,product,capabilities}/` now ships with:
  - A `WHAT THIS FILE IS` block (purpose + when read)
  - A `WHEN TO FILL IT IN` block (auto-fill behavior + status flip)
  - A `FORMAT` block with two concrete fictional examples (FoxGlove
    Florist + Northstar — clearly placeholder, no real
    organizations referenced)
  - The body shows the auto-fill output instead of a hostile
    `(operator: replace this paragraph with your brand summary)`
    placeholder. New adopters see what "filled" looks like.

  Files updated:
  - `brand/overview.md`
  - `brand/voice.md`
  - `product/positioning.md`
  - `product/personas.yaml`
  - `capabilities/mcp-tools.yaml`
  - `capabilities/skills.yaml`
  - `capabilities/snippets.yaml`

## [0.3.2] — 2026-05-06

Hotfix on top of v0.3.1.

### Fixed

- **`cairn doctor` exit code 1 / 2 on healthy adopted projects.** The
  v0.3.0 doctor flagged two false errors that broke `cairn-check.yml`
  CI in adopted projects:
  1. `.mcp.json missing — run cairn init` — project-level `.mcp.json`
     is forbidden in plugin-mode (the plugin's bundled `.mcp.json` is
     the single registration source per
     [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md)). Removed the check
     entirely.
  2. `brand/overview status:draft` — flagged as warning, but brand
     overview is operator-paced (no visual-identity decisions exist
     at adoption time for most projects). Doctor now reports it as
     `ok` with detail "fill in when ready (operator-paced)".

  Net: a freshly-adopted project with default Phase 5 auto-fill now
  passes `cairn doctor` cleanly (exit 0), unblocking CI.

## [0.3.1] — 2026-05-06

Hotfix on top of v0.3.0.

### Fixed

- **Adopted-project CI workflow template was broken.** Phase 3b-seed
  writes `.github/workflows/cairn-check.yml`; the template called
  `cairn sensor-run --diff <range> --strict` which doesn't match the
  actual CLI (`--staged | --commit-msg <path>`), exit 2. Replaced
  with `cairn doctor` — read-only ground-state health check that
  works today. Also bumped runner Node to `22` (cairn requires
  `>=22`; v0.3.0 template still pinned `20`, triggering EBADENGINE
  warnings on `npm install -g`).
- **`resolveRepoRoot` falsely matched template content.** Walking
  up from a file inside the cairn source tree picked up
  `cairn-core/templates/.cairn/` (the adoption skeleton) and treated
  the templates dir as a real adopted project — which made
  `write-guardian` block edits on the cairn dev repo with
  `decision: "block"`. Fix: require `.cairn/config.yaml` to be
  present, not just the `.cairn/` directory. Adopted projects
  always have `config.yaml` (Phase 3b-seed); templates never do.

## [0.3.0] — 2026-05-06

Major architectural cleanup + deterministic-enforcement push. The
spec-tightening contract is now server-controlled (`cairn_task_create`
MCP tool) instead of skill-body advisory. Hard cutover — no
backward-compat shims, no transition layers.

### Breaking changes

- **`V0001` → `INV-NNNN` rename, system-wide.** Schema regex
  `/^V\d{4,}$/` → `/^INV-\d{4,}$/`. Bare-symbol citation `§V<NNNN>` →
  `§INV-NNNN`. Filename `V0001.md` → `INV-0001.md`. Lens decorations,
  citation scanner, legend builder, mapper prompts, templates,
  smokes, and test fixtures all migrated. Existing `V0001`-format
  projects need re-init or manual migration.
- **`cairn-bootstrap` skill removed.** SessionStart hook auto-runs
  `cairn join` synchronously when `core.hooksPath` is unset.
  Bootstrap is local-clone state only — `git config` + chmod +
  gitignored sentinel files — so plugin install is implicit consent.
  Banner now only renders on bootstrap *failure*.
- **`cairn-statusline-setup` skill → `/cairn-statusline-setup`
  command.** Manual one-time setup, no auto-invoke. Drops a skill
  listing entry on every session.
- **`cairn-frontend-stub` package deleted.** Internal in-memory test
  adapter no longer maintained; e2e smokes exercise `cairn-core`
  directly.
- **`cairn_append_run_note` MCP tool removed.** Subagents `Write` to
  `notes.md` directly.
- **PostToolUse(Write|Edit) returns `decision: "block"` on bypass.**
  Edit on a tracked source file without a tightened spec is rejected
  with a structured recovery reason — strong feedback signal, not
  advisory. Replaces the v0.2.x scope-only reminder.
- **`workflow.md` body wiped.** Liquid tokens (`{{mirror_path}}`,
  `{{sha_pin}}`, `{{run_id}}`) from the orchestrator era removed;
  only the frontmatter (active surface that `init/workflow-block.ts`
  patches and `sensors/runner.ts` reads) is kept.

### Added

- **`cairn_task_create` MCP tool.** Server-controlled task lifecycle
  entry. Allocates `task_id` matching
  `^TSK-\d{4}-\d{2}-\d{2}-[a-z0-9-]+-\d{5}$` and atomically writes
  `spec.tightened.md` + `status.yaml` under
  `.cairn/tasks/active/<task_id>/`. Caller cannot misformat the id
  or skip `status.yaml`. Required by the cairn-direction contract.
  Schema: `slug`, `title` (≤50 chars, statusline-friendly), `goal`,
  `target_path_globs`, `in_scope_decisions`, `in_scope_invariants`,
  `constraints`, `out_of_scope`, `acceptance`, `module`.
- **`code_change_contract` SessionStart section.** Top-priority
  inject explaining the 5-step workflow: ToolSearch preload →
  `cairn_*_in_scope` lookups → `AskUserQuestion` → `cairn_task_create`
  → Edit. Sits in `additionalContext` above any skill body. Hard
  rule, not advisory. Survives truncation.
- **`UserPromptSubmit` hook.** Resolves `§INV-`/`§DEC-`/`TODO(TSK-)`
  citations in `@`-attached files (Read-tool-bypass path). Parses
  `@<path>` from the raw prompt, scans each file, emits the legend
  as `additionalContext`. Plugs the gap where Claude Code's
  context-attachment shorthand sidesteps `PostToolUse(Read)`.
- **Bypass-detection in write-guardian.** Edit on a git-tracked
  source without an active tightened task →
  `{continue: false, decision: "block", reason: ...}` with
  step-by-step recovery (revert + `cairn_task_create` + retry).
  Per-session sentinel
  (`.cairn/sessions/<sid>/bypass-warned`) dedupes follow-up edits so
  the operator gets one block per untightened state, not N. Source
  detection defers to `git check-ignore` — no language allowlist.
- **Auto-bootstrap in SessionStart hook.** `runJoin` runs
  synchronously when state needs it. Idempotent + harmless. Banner
  only on failure.
- **Phase-gate on `scanPendingReviews`.** Stop-hook reviewer-
  attestation prompt only fires for tasks where
  `phase ∈ {ready_for_review, awaiting_attestation}`. Fresh
  `running` tasks no longer trigger an attention loop.
- **Init Phase 7b post-population.** Strip-replace folds
  `§INV-NNNN` source cites into `scope-index.yaml` immediately, so
  the in-scope MCP tools resolve them right after init.
- **PostToolUse(Write|Edit) scope sync.** Every agent write parses
  `§INV-`/`§DEC-` tokens in the new content and updates
  `scope-index.yaml` for that file. No staleness window during a
  session.
- **In-scope MCP tools two-source resolution.**
  `cairn_invariants_in_scope` + `cairn_decisions_in_scope` now query
  both `source_decision.scope_globs` AND scope-index entries' input
  globs. Init-extracted INVs/DECs without canonical metadata still
  resolve.
- **`cairn scope rebuild` CLI subcommand.** Deterministic regex
  sweep over source files; rebuilds scope-index without LLM tokens.
- **Huge-codebase guards.** `BASELINE_FILE_CAP = 5000` (Phase 8),
  `DEFAULT_FILE_CAP = 5000` (Phase 7b walker), `MAPPER_SLICE_CAP =
  50` (Phase 3 mapper). Phase 7b classifier runs 4-way parallel
  rounds (~4× speedup; Haiku TPM ceiling absorbs it).
- **Mapper LLM determinism cuts.** `proposed_sensors` removed from
  mapper output (sourced directly from Phase 1 `stack_signatures`).
  New `inferGlobsFromDetection(detection, repoRoot)` pre-fills
  baseline globs from framework conventions. Mapper-merge Haiku
  scope reduced to `pilot_module + domain_summary + notes`;
  mechanical baseline fallback on Haiku failure.
- **`AskUserQuestion` contract.** ≤3 questions per call; total
  across rounds unbounded. Loop when Q1's answer changes Q2/Q3.
- **TODO(TSK-) full integration.** `cairn-direction` dispatch briefs
  instruct subagents to drop `// TODO(TSK-<task_id>)` on deferred
  lines. Reviewer agent flags partial implementations via
  `remaining_concerns`.
- **Skill-listing budget enforcement** (`check-layout.mjs`).
  Validates `description + when_to_use` combined ≤ 1400 chars
  (Claude Code's `skillListingMaxDescChars` default is 1536; cap at
  1400 for headroom). Build fails on violators.
- **`docs/SYSTEM_OVERVIEW.md`.** Single-source-of-truth map of every
  surface, every flow, every state file. Mermaid diagrams for
  architecture / init flow / daily flow.

### Fixed

- **`task_id` never populated the statusline.** `cairn_task_create`
  writes `status.yaml` alongside `spec.tightened.md`; the
  resume-from-anywhere statusline row renders correctly.
- **`cairn_invariants_in_scope` returned `[]`** for source-comment-
  extracted INVs. Two-source lookup landed.
- **Mapper LLM smuggled prose into scope-index arrays.** ID coercion
  at parse + merge + rebuild — defense-in-depth.
- **Phase 7b classifier ran sequentially** — 80 min on huge repos.
  Now parallel rounds of 4.
- **`cairn-attention` Step 4** ran a broken
  `node -e require('@isaacriehm/cairn-core')` against the ESM
  bundle. Removed; Stop hook covers the same advance.
- **`cairn-attention` edit-first flow** asked "what to change?"
  without rendering the draft body. Step 3a now renders the full
  draft inline before `AskUserQuestion`.
- **Skill description silent drop.** Long `description +
  when_to_use` got dropped from Claude Code's listing without
  warning. `check-layout.mjs` now blocks at build; trimmed
  `cairn-direction` (1797 → 1227), `cairn-adopt` (639 → 480),
  `cairn-attention` (513 → 447), `agents/reviewer.md` description
  (389 → 175).
- **Statusline phantom writes.** `writeStatusJson` refuses when
  `.cairn/` is missing — no more accidental
  `.cairn/sessions/<sid>/` directory creation in non-adopted
  projects.
- **Read-enricher trace pollution.** Skips trace writes on
  `no-cairn-ancestor` outcomes; `~/.local/cairn/trace/` stays quiet
  outside cairn-adopted repos.
- **Statusline truncation.** `cairn_task_create` separates `title`
  (≤50 chars, statusline) from `goal` (full description, spec
  body).
- **`statusline_unset` signal had no producer.** Removed from
  `cairn-statusline-setup`.
- **Skill-listing entries silently dropped on Sonnet.** Cairn
  skills' bodies trimmed; README documents the
  `skillListingBudgetFraction: 0.03` workaround for adopters on
  lower-context models.

### Removed

- `cairn-core/src/tier0/` (3 files) — Haiku prompt classifier;
  folded into cairn-direction's `when_to_use` gate.
- `cairn-core/src/tightener/` (5 files) — spec-tightener backend.
- `cairn-core/src/decision-capture/{extractor, prompt, schema,
  refinement-prompt, refinement-schema, writer, types}.ts` — Tier-1
  LLM extractor + refinement pipeline. Kept only `id.ts` (monotonic
  ID allocator).
- `cairn-core/src/mcp/tools/append-run-note.ts` +
  `appendRunNoteInput` schema.
- `cairn-core/src/context/checkpoint.ts` — `writeCheckpoint`. No
  callers.
- `cairn-core/src/prompt.ts` — `loadWorkflowTemplate` +
  `renderTemplate`. Orchestrator-era prompt renderer.
- `packages/cairn/scripts/smoke-tier0.ts` — dead smoke.
- `packages/cairn/scripts/smoke-bootstrap-skill.ts` — bootstrap
  skill replaced by SessionStart auto-run; smoke obsolete.
- `packages/cairn-frontend-claudecode/skills/cairn-bootstrap/` —
  whole skill dir.
- `packages/cairn-frontend-claudecode/skills/cairn-statusline-setup/`
  — moved to `commands/cairn-statusline-setup.md`.
- `packages/cairn-frontend-stub/` package.

### Operator workflow notes

- **Sonnet adopters need `skillListingBudgetFraction: 0.03`** in
  `~/.claude/settings.json`. The default `0.01` (~2k chars on
  Sonnet's 200k context) is too tight once user-level plugins are
  installed — cairn skills get dropped from the auto-invoke listing
  silently.
- **Add `refreshInterval: 30`** to the `statusLine` block in
  user-level settings. Cairn writes `status.json` from MCP tools
  mid-flight; without periodic re-poll the badge lags until the
  next prompt or tool result.
- **Cursor / VS Code lens upgrade.** Install
  `packages/cairn-lens/cairn-lens-0.3.0.vsix` (Cmd-Shift-P →
  "Extensions: Install from VSIX"). The lens regex was migrated to
  `§INV-NNNN` — older `0.2.x` builds no longer resolve citations.

## [0.2.0] — 2026-05-05

Architectural reset. The plugin pivot from v0.1.x is complete: Cairn now
ships as a self-contained Claude Code plugin bundle, with the CLI as the
bootstrap and debug entrypoint. Hard cutover — no legacy paths, no
transition shims.

### Added

- **Self-contained plugin bundle.**
  `packages/cairn-frontend-claudecode/dist/cli.mjs` (esbuild ESM)
  carries hooks, MCP server, init pipeline, and CLI in one file. No
  `npx`, no `npm install -g`, no PATH dependency for plugin users.
- **MCP-native init pipeline.** Twelve phase tools
  (`cairn_init_phase_<id>`) plus `cairn_init_resume`. The
  `cairn-adopt` skill drives the loop as a state machine: resume →
  call phase → AskUserQuestion if `needs_input` → re-call with
  answer until `nextPhase===null`.
- **Phase 3b-seed.** Writes `.cairn/` skeleton + `config.yaml` +
  `scope-index.yaml` between mapper and pilot. Also seeds
  `.cairn/.attested-commits` early so the Stop-hook bypass detector
  grandfathers pre-adoption commits.
- **`cairn-bootstrap` skill.** Auto-invokes when the SessionStart
  banner flags an adopted-but-not-joined clone. Spawns the bundled
  `cli.mjs join` subprocess inline.
- **`cairn-statusline-setup` skill.** Writes the user-level
  `~/.claude/settings.json` `statusLine` entry resolved through a
  shim path that survives plugin upgrades.
- **Stop-hook signal debounce.** `[c]` defer 24h on a bypass /
  reviewer surface writes `.cairn/.{bypass,review}-deferred-until`;
  subsequent Stop ticks suppress the warning until the deferred set
  changes or the window expires.
- **Source-comment strip on DEC accept.**
  `cairn_resolve_attention` (kind=`decision_draft`, choice=`a`) now
  looks up the originating source-comment audit, builds a
  `// See DEC-NNNN` (or `# See DEC-NNNN` for hash-comment langs)
  citation, and runs `applyStripReplace` on the source file.
  Best-effort — strip failures never roll back acceptance.

### Changed

- **Plugin manifest owns the hook surface.** Project-level
  `.claude/settings.json` is no longer seeded; hooks live in the
  plugin's own `hooks/hooks.json`.
- **Hook resolution.** Git hooks read `.cairn/.cli-path` (written by
  `cairn join`) to invoke the bundled CLI; fall back to a global
  `cairn` if available, exit silently if neither is present.
- **`cairn sensor-run` subcommand.** New CLI entry point for the
  pre-commit / commit-msg hooks. Loads `.cairn/config/sensors.yaml`,
  filters by trigger, exits clean. Sensor execution against staged
  diffs is reserved for v0.2.1.
- **`resumePhases` contract.** The persisted `state.currentPhase`
  IS the next phase to invoke. Phase functions advance via
  `advancePhase` before the MCP tool persists, so a session that
  interrupts mid-init resumes at exactly the phase that hadn't run.
- **`attention_count`** in the status row sums pending DEC drafts +
  baseline findings + drift findings (was: drafts only).
- **Stop-hook `additionalContext`** clamped to 4 KB before flowing
  back as `systemMessage` so concurrent reviewer + bypass surfaces
  can't blow the envelope budget.
- **Reviewer hint wording.** "run review" replaces "spawn reviewer"
  (the latter was a Claude-mechanism leak into operator-facing text).
- **Skill A/B/C option labels** under 30 chars so they don't
  truncate in mobile mode (10-strip, 5-brand, cairn-bootstrap,
  cairn-adopt).
- **`bypass-detection`** `git log` format uses NUL (`%x00`) as the
  SHA/subject separator so commit subjects containing tabs parse
  correctly.

### Removed

- **Daemon-era surface.** `daemon_alive`, `ctx_tokens_used`,
  `ctx_tokens_budget` fields removed from `StatusJson`. The
  `DAEMON_UNAVAILABLE` MCP error code is gone (`OPERATION_TIMEOUT`
  replaced its semantic uses; `INTERNAL_ERROR` covers I/O failures).
  Source-comment references to "daemon" / "v0.3 daemon return" /
  "pre-pivot" purged across the codebase, docs, and templates.
- **`package.json` `prepare` auto-patch.** Phase 12-multidev no
  longer wires `cairn join || true` into `scripts.prepare`. The
  Claude Code SessionStart bootstrap banner owns per-clone
  bootstrap; CLI-only contributors run `cairn join` manually after
  `npm install`. (Prevents `sh: cairn: command not found` noise on
  installs.)
- **`templates/README.md`.** npm-internal documentation that the
  seed walker would inadvertently copy into adopted projects'
  README slot. Deleted.
- **v0.1.x transition history** scrubbed from source-comment
  headers (5-brand, 3-mapper, defer, 10-strip, types).

### Fixed

- **`cairn sensor-run` subcommand previously did not exist.** Every
  commit on a cairn-joined clone failed with "unknown command".
  Subcommand wired; hooks updated to invoke through it.
- **Stop-hook bypass detection** flagged every pre-adoption commit
  as `--no-verify` until phase 12 ran (last). Seeding moved to
  phase 3b-seed (early); Stop hook also suppresses bypass +
  reviewer scans entirely while `.cairn/init-state.json` exists.
- **`cairn_append_run_note`** was writing without a flock and
  skipping the bootstrap guard. Both added.
- **DEC accept** previously left orphan `*.accepted.bak` files in
  `_inbox/`. Replaced with a single cleanup `rmSync`.
- **`suppressions.yaml`** empty-file edge case produced invalid YAML
  (missing root key). Now seeds the header when needed.
- **Phase 3b-seed** workflow.md patch failure no longer aborts
  adoption. Records the error string in the phase output and
  proceeds to the config.yaml + scope-index writes.
- **`cairn-attention` skill** explicitly directs `cairn_decision_get`
  for each draft path; the skill no longer defaults to `cat`-ing
  every DEC body (the previous flow could waste thousands of
  tokens per attention pass).
- **JOIN.md `/plugin install`** instructions now show the
  `/plugin marketplace add isaacriehm/cairn` prerequisite.
- **`cairn-lens` engines.vscode** lowered from `^1.118.0` to
  `^1.96.0` so the VSIX installs on Cursor 3.2.21 (VS Code 1.105.1
  backing). Lens uses no API past 1.85.

### Smoke gate

28 smokes pass on a clean tree:
`plugin-layout`, `resolve-attention`, `stop-hook`, `events`,
`session-state`, `status-line`, `session-start`, `handoff`,
`scope-index`, `read-enrich`, `init`, `ingestion-baseline`, `tier0`,
`gc`, `lock`, `source-comments`, `rules-merge`, `join`,
`bypass-detection`, `bootstrap-guard`, `e2e-adoption`,
`e2e-daily-flow`, `plugin-bundle`, `init-phases-state`,
`init-phases-all`, `init-mcp-tools`, `stop-debounce`,
`bootstrap-skill`.

[0.2.0]: https://github.com/isaacriehm/cairn/releases/tag/v0.2.0
