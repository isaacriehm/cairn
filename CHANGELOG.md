# Changelog

All notable changes to Cairn are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
