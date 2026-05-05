# Changelog

All notable changes to Cairn are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
