---
type: build-log
generated: 2026-05-03
---

# Harness Build Log

Append after each task. Format:

```
## Task N — <name> [DONE|PARTIAL|FAILED] <timestamp>
Subagent attempts: N
Compile: PASS|FAIL
Notes: <anything unusual>
```

---

<!-- entries appended below by Opus during build session -->

## Post-Pre-Flight Additions [2026-05-04]
Added: scope-index design (spec only, new build task added — Task 9)
Added: spec delta injection (spec only, Task 3 amended to also implement buildSpecDelta + SpecDelta type)
Compile: PASS

## Task 1 — Remove banned MCP tools from public surface [DONE 2026-05-04T01:46]
Subagent attempts: 1
Compile: PASS (both packages)
Notes: tools/index.ts was already at target state from prior pre-flight; only templates.ts needed edits (TOOL_QUICK_REFERENCE write section + Operator dialog block stripped). allTools confirmed at 14 entries.

## Task 2 — Status line module [DONE 2026-05-04T01:55]
Subagent attempts: 1
Compile: PASS (both packages)
Notes: 4 new files under packages/harness-core/src/status-line/. Reused mirror/paths.ts normalizeProjectName + projectStatePath. CLI status-line subcommand outputs placeholder string when no state file exists. Confirmed runtime via `npx tsx src/cli/index.ts status-line` → `⬡ harness  daemon:down  ○`.

## Task 3 — Context module: handoff builder + spec delta [DONE 2026-05-04T02:05]
Subagent attempts: 1
Compile: PASS (both packages)
Notes: 4 new files under packages/harness-core/src/context/. Manual fix on handoff renderer — taskId already starts with "TSK-" so the `TSK-${taskId}` template would have doubled the prefix; corrected to bare `${parts.taskId}`. Spec delta uses set-difference pattern for superseded entries (HEAD ledger only contains accepted+active). Brand stat checks `.harness/ground/brand/{overview,voice}.md` + `product/{positioning,personas}.{md,yaml}`.

## Task 4 — Session-start Section 0 handoff injection [DONE 2026-05-04T02:18]
Subagent attempts: 1
Compile: PASS (both packages); smoke-session-start PASS (6 steps)
Notes: buildSessionStartContext now async; "run_handoff" added as first orderedSection + LAST in dropPriority (most-protected). Manual fix in hook.ts — subagent flagged that source wasn't being passed through buildArgs; added `if (source !== null) buildArgs.source = source;` so handoff fires in production.

## Task 4b — Session-start brand + product positioning injection [DONE 2026-05-04T02:28]
Subagent attempts: 1
Compile: PASS (both packages); smoke-session-start PASS (8 steps — original 6 + new 7/8)
Notes: brand_and_positioning section added between two_zone_reminder and tool_quick_reference; placed in dropPriority between pending_drafts and invariants_active. readBrandAndPositioning emits [DRAFT — ...] hint when frontmatter status is "draft". Subagent ran `pnpm build` on harness-core for the smoke (consumes via dist/) — smoke runner imports through @devplusllc/harness-core which resolves to built dist.

## Task 5 — PostToolUse read enricher [DONE 2026-05-04T02:50]
Subagent attempts: 1
Compile: PASS (both packages); runtime smoke PASS (Bash pass-through, Read with citations on /tmp/ path produces empty additionalContext since no .harness/ ancestor)
Notes: 5 new files under packages/harness-core/src/hooks/post-tool-use/. Output uses additionalContext (NOT modified_tool_response — that's not a documented Claude Code field). Top-level try/catch wraps everything; defer-fail emits Shape B empty + exit 0. Scope-index reader is a stub inside read-enricher.ts; Task 9 will refactor into shared ground/scope-index.ts. citation-scanner strips leading \d+\t (cat -n) for line-number computation only. hook.ts updated by linter post-edit to add docblock entry — kept.

## Task 6 — PostToolUse write guardian + sensors.yaml extension [DONE 2026-05-04T03:00]
Subagent attempts: 1
Compile: PASS (both packages)
Notes: 3 new files (copy-scanner, allowlist-reader, write-guardian). Sensors.yaml gets copy_safety block between required_glob_keys and disabled_per_project. JSX/TSX uses regex-based string-literal extractor (not full AST). JSON only scans values. Other extensions scan entire content. Scope-index reader duplicated from read-enricher.ts; Task 9 will refactor both call sites into shared module.

## Task 7 — Init: register PostToolUse hooks in settings.json template [DONE 2026-05-04T03:08]
Subagent attempts: 0 (inline, template-only)
Compile: PASS; valid JSON; 3 PostToolUse entries
Notes: settings.json template was previously gitignored (`.claude/` rule at root caught it). Added exception `!packages/harness-core/templates/.claude/` + `!packages/harness-core/templates/.claude/**` to .gitignore so the template tracks. Then wrote new template content with SessionStart + 3 PostToolUse matchers (Read→read-enrich, Write→write-guard, Edit→write-guard) using `npx -y @devplusllc/harness hook <event>`.

## Task 8 — Seed brand/product/capabilities ground templates [DONE 2026-05-04T03:14]
Subagent attempts: 0 (inline, template-only)
Compile: PASS; seedHarnessLayout smoke against fresh tempdir copied all 5 files
Notes: 5 new files under packages/harness-core/templates/.harness/ground/ — brand/overview.md (status: draft), product/positioning.md (status: draft), capabilities/{skills,mcp-tools,snippets}.yaml (empty arrays). seedHarnessLayout walks templates/ recursively so no code changes needed.

## Task 9 — Scope index: type, init seed, hook integration, GC pass [DONE 2026-05-04T03:35]
Subagent attempts: 1
Compile: PASS (both packages); runtime smoke: scope_index_missing finding works, readScopeIndex/writeScopeIndex/lookupScope round-trip works, scope_uncovered emits for files not in index
Notes: 3 new files (ground/scope-index.ts, gc/walk-source.ts, gc/scope-coverage.ts). Refactored stub-hits.ts to use shared walk-source. ledger-cache.ts gained getScopeIndexEntry with mtime cache. read-enricher.ts and write-guardian.ts both refactored to use cached version (deleted private duplicates). Mapper schema gets scope_index field (NOT in required — older mappers tolerated). init.ts adds Step 3b that writes empty {files:{}} skeleton when --skip-mapper. Manual fix: added `.harness` to SOURCE_TREE_SKIP_DIRS so scope-coverage doesn't flag .harness/ files as uncovered.

## Task 10 — GC completion-integrity pass [DONE 2026-05-04T03:42]
Subagent attempts: 1
Compile: PASS (both packages)
Notes: New gc/completion-integrity.ts. For each task in tasks/done/, validates phase=succeeded, related_run_ids[last] runId resolves to runs/{terminal,active}/<runId>/, meta.json parseable with sha_pin, attestation.yaml present, sensor-results.yaml has no non-pass entries, sha reachable via git.catFile([-e, sha]). All findings task_integrity_error severity warn. Pass 6 in sweep.ts ordering (between quality-grades and scope-coverage).

## Task 11 — GC citation-integrity pass [DONE 2026-05-04T03:50]
Subagent attempts: 1
Compile: PASS (both packages)
Notes: New gc/citation-integrity.ts. Reuses scanCitations from hooks/post-tool-use + walkSourceTree from gc/walk-source. Restricts to TEXT_EXTS (no .json/.yaml/.md). For §V citations: superseded_citation if id has superseded_by in raw ledger; orphaned_citation if absent from active ledger. DEC-N inline comments → banned_dec_comment per PRIMER §10. TODO(TSK-) citations checked against tasks/{active,done}/<id>/; done dirs are silent (will be removed). Pass 8 in sweep.ts.

## Task 12 — harness_append_run_note MCP tool + path-allowlist extension [DONE 2026-05-04T03:58]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); runtime smoke: allTools count=15, isAppendAllowed(.harness/tasks/active/TSK-001/notes.md)=true
Notes: New mcp/tools/append-run-note.ts. APPEND_ALLOWLIST gains .harness/tasks/active/*/notes.md. Schema appendRunNoteInput has run_id (path-safe regex, ≤80) + phase (≤80) + note. Handler validates run_id, checks task dir exists (RUN_NOT_FOUND if not), appends `\n## <ISO> [<phase>]\n<note>\n` to notes.md. Initial INVALID_RUN_ID code wasn't in McpErrorCode union — switched to VALIDATION_FAILED.

## Task 13 — Smoke tests for new modules [DONE 2026-05-04T04:08]
Subagent attempts: 0 (inline)
Compile: PASS; all 4 new smokes PASS; existing smoke-session-start still PASS (8 steps)
Notes: 4 new smoke scripts under harness/scripts/: smoke-status-line.ts (4 steps incl. priority ordering), smoke-handoff.ts (3 steps null-cases), smoke-scope-index.ts (3 steps incl. unscoped flag), smoke-read-enrich.ts (4 steps incl. scope-hint integration). package.json gets four new pnpm scripts. The Task 4b session-start smoke step was already added during Task 4b — no additional changes needed there.

## Bonus — Lens VS Code extension [DONE 2026-05-04T04:30]
Subagent attempts: 0 (inline)
Compile: PASS (whole workspace); smoke-resolver PASS (5 steps)
Notes: User-requested after the 14-task base was done. LENS_SPEC.md was originally marked out-of-scope for the overnight build. Created packages/harness-lens/ with package.json (VS Code extension manifest), tsconfig referencing harness-core, src/{extension,resolver}.ts, src/providers/{hover,decoration,lens}-provider.ts, src/panel/dec-explorer.ts, scripts/smoke-resolver.ts. Resolver wraps harness-core ledger-cache + scope-index reader. Activates on workspaces with .harness/. Hover (§V/TSK), inlay-style ghost text + gutter health icons (●/◐/○), CodeLens above first function-like line when file in scope, optional DEC explorer TreeDataProvider. ESM extension (main = dist/extension.js), VS Code 1.85+. All 6 LENS_SPEC §2 features implemented except live file-watcher invalidation pings — wired but not unit-tested (needs vscode runtime).

## Task E — Gitignore exception audit [DONE 2026-05-04T04:45]
Subagent attempts: 0 (inline audit, no code change)
Notes: `git ls-files packages/harness-core/templates/.claude/` shows only the one expected file (settings.json). `git check-ignore -v .claude/` confirms root `.claude/` still ignored via .gitignore:25. `git check-ignore -v harness/.claude/` confirms sibling `.claude/` dirs still ignored. No other `.claude/` files have leaked into tracked set. Exception scope correct — no fix needed.

## Task B — Scope index cache mtime → sha256 content hash [DONE 2026-05-04T04:50]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-read-enrich PASS (4 steps)
Notes: ledger-cache.ts getScopeIndexEntry now keys on sha256 of first 512 bytes via node:crypto createHash. Added hashFilePrefix() helper using openSync/readSync for fixed-size partial read (avoids loading full file when only the digest matters). ScopeIndexCacheEntry.mtimeMs replaced by contentHash: string. Closes BUILD_REPORT Gap 6 (clock-skew stale cache).

## Task A — harness scope rebuild command [DONE 2026-05-04T04:55]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); CLI smokes: `harness scope` → usage; `harness scope rebuild --repo /no/such/dir` → error+exit2
Notes: ground/scope-index.ts gains rebuildScopeIndex() that calls detectAll → buildRepoSummary → runClaude (sonnet tier) with the existing MAPPER_SYSTEM_PROMPT (extended to ask for scope_index per file). Coerces mapper-shape `unscoped: boolean` → ground-shape `unscoped: true` literal. Returns { path, filesClassified, mapperDurationMs, model }. New harness/src/cli/scope.ts dispatches to rebuildHandler. Root CLI usage gains `scope rebuild [--repo <path>]`. Closes BUILD_REPORT Gap 1.

## Task C — Beautiful init: brand setup + daemon autostart + structured summary [DONE 2026-05-04T05:10]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS — completion summary renders within 100-char width
Notes: New init/brand-setup.ts (4-question readline wizard, applies answers to product/positioning.md + product/personas.yaml + brand/voice.md, flips status: draft → status: current per file). New init/daemon-autostart.ts (spawns `harness daemon start --detach`, polls status.json for ≤1.5s, returns DaemonAutostartResult). init.ts wires Phase 5b after seed/scope-index, Phase 5c right after, replaces the old "Done. Next steps" block with printCompletionSummary() that renders Ground state / MCP server / Hooks / Sensors / Brand / Scope index / Daemon rows + Next steps. RunInitArgs gains skipBrandSetup, scriptedBrandAnswers, skipDaemonAutostart for smokes. InitResult gains brand_setup + daemon_autostart fields. Two new ground templates: brand/voice.md + product/personas.yaml. Skipping all 4 questions in `auto` mode leaves files draft (current behaviour preserved).

## Task D — harness doctor + harness fix commands [DONE 2026-05-04T05:25]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); CLI smokes: doctor on healthy fixture exits 0; doctor on warn-only fixture exits 2; doctor on error fixture exits 1 (verified via direct invocation, no pipe)
Notes: New packages/harness-core/src/doctor/index.ts — runDoctor() returns DoctorReport (core/ground/sensors groups). runFix() takes injectable rebuildScopeIndexFn / startDaemonFn so tests don't need real LLM/daemon. Sensor checks cross-reference sensors.yaml `command` against PATH via builtin which()-replacement using node:path delimiter. New harness/src/cli/doctor.ts — render with ✓/⚠/✗/○ icons, exit code 0/1/2 by status. fixCli wires rebuildScopeIndex + tryStartDaemon. Public barrel exports runDoctor, runFix, applyBrandAnswers, runBrandSetup, tryStartDaemon. Root CLI usage gains `doctor` + `fix` subcommands.

## Task F — Compile Lens into .vsix [DONE 2026-05-04T05:35]
Subagent attempts: 0 (inline)
Compile: PASS (whole workspace); vsce package PASS (267 KB vsix produced)
Notes: Added esbuild + @vscode/vsce as devDeps. New `bundle` script (esbuild → dist/extension.cjs, CJS, externals: vscode + fsevents) and `package` script (clean + bundle + vsce package --no-dependencies). Renamed package from @devplusllc/harness-lens to harness-lens (vsce rejects scoped names; lens isn't depended on by other workspace packages). main → dist/extension.cjs. Added .vscodeignore (excludes src/, scripts/, loose tsc dist files) and README.md. devplusllc-harness-lens-0.0.0.vsix produced; 1.4 MB extension.cjs bundles harness-core + transitive deps (yaml, simple-git, zod, pino, etc.). 3 esbuild warnings about `import.meta.url` in harness-core init/* paths are cosmetic — those code paths never execute from the Lens runtime.

## Task D — Submodule note in completion output [DONE 2026-05-04T06:25]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS — zero JSON lines confirmed via grep -cE pattern
Notes: describeScopeIndex now returns ScopeReport { line, followUp } instead of bare string. When submodules.initialized && submodules.success: scope-index line reads "partial — N files classified (submodules now initialized)" + follow-up row "Run harness scope rebuild for full classification". When scope-index empty AND submodules just initialized: line reads "empty — submodules now initialized, run harness scope rebuild". Final smoke-init `grep -cE '"level":|"time":|"pid":'` reports 0 — no JSON visible in operator-facing output.

## Closing summary [2026-05-04T06:25]
Tasks A, B, C, D: all DONE. Whole-workspace tsc -b clean.
New files:
  packages/harness-core/src/init/submodules.ts
  packages/harness-core/src/init/visual.ts
Modified:
  packages/harness-core/src/init/init.ts (Phase 0 log redirect + Phase 1 submodule preflight + streamed discovery + ora mapper spinner + cli-progress whisper + single-confirm flow + ScopeReport submodule note)
  packages/harness-core/src/init/setup-runners.ts (whisper download via fetch + cli-progress)
  packages/harness-core/src/logger.ts (proxy Writable + setLogFile/setLogStderr/setLogNull)
  packages/harness-core/src/index.ts (re-export setLogFile etc)
  packages/harness-core/package.json (chalk, ora, cli-progress, @types/cli-progress)
Acceptance: harness init produces 0 JSON log lines in stdout; logs written to ~/.local/harness/logs/init-<ISO>.log; submodule prompt fires before walker when .gitmodules present with uninitialized entries; ora spinner during mapper; cli-progress bar during whisper download; single confirm = pilot module path.

## Task C — Visual overhaul of init terminal output [DONE 2026-05-04T06:18]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS — completion summary shows Log row, discovery streams, single-confirm flow
Notes: Added chalk + ora + cli-progress + @types/cli-progress as deps. New init/visual.ts wraps icons (✓ green / ⚠ yellow / ✗ red), withSpinner() for long-task ora wrapper, startProgress() cli-progress bar with TTY fallback. Replaced printSummary + printAdvisoryWarnings with printDiscovery — streamed `Scanning...` rows for git root / project slug / remote (shorthand) / stack / Claude Code / ollama / whisper / Discord. Removed proceed prompt + Discord credentials prompt + mapper dispatch prompt + apply/edit/skip prompt. Mapper now dispatches automatically inside withSpinner("Analyzing codebase (this takes ~60s)…"); single confirm = pilot module via freeTextWithDefault (Enter applies, alternate path overrides). printMapperProposal redesigned: Project / Modules · separated / Sensors (top 3 + "+ N more" / Pilot. downloadWhisperModel uses fetch + cli-progress bar with byte counts + transfer rate (no curl). secretInput / upsertHarnessEnv / editYaml imports removed.

## Task B — Suppress logger leakage to stdout during init [DONE 2026-05-04T06:02]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init verified zero JSON lines in stdout + log file at ~/.local/harness/logs/init-<ISO>.log
Notes: logger.ts gains a proxy Writable that pino targets at construction. Default destination = nullStream() (drops output) so any package using `logger()` outside an explicit redirect produces no terminal noise. New setLogFile(absPath) opens an append WriteStream; setLogStderr() / setLogNull() handle daemon + smoke cases. Children created via `logger(module).child(...)` keep working because the proxy reads `activeDestination` at write-time. init.ts Phase 0 redirects to ~/.local/harness/logs/init-<ISO>.log immediately. InitResult.log_file_path string|null surfaces the path to callers + completion summary renders `Log  ~/.local/...` row when non-null. shortenHomePath helper.

## Task A — Submodule detection + init prompt [DONE 2026-05-04T05:55]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS — Phase 1 noop on temp dir without .gitmodules
Notes: New init/submodules.ts — scanSubmodules() reads .gitmodules + parses `git submodule status` (head char `-` = uninitialized). runGitSubmoduleUpdate() spawns `git submodule update --init --recursive --progress`, streams onProgress events (registered/checkout/info), returns {ok, errorSummary}. init.ts gains preflightSubmodules() that runs after `header()` and BEFORE detectAll/walk. RunInitArgs gains skipSubmoduleCheck + autoSubmodule ("init"|"skip"). InitResult.submodules: { detected_uninitialized[], initialized, success } | null. yesNo prompt with defaultYes — interactive Enter = init. On init failure: warning pushed, init continues with partial codebase (no hard exit per acceptance criterion). Compile clean both packages.

## Closing summary [2026-05-04T05:40]
Tasks E, B, A, C, D, F: all DONE.
Final compile: PASS for packages/harness-core, harness, packages/harness-lens.
Total new files (this session, excluding lockfile): 12.
  packages/harness-core/src/init/brand-setup.ts
  packages/harness-core/src/init/daemon-autostart.ts
  packages/harness-core/src/doctor/index.ts
  packages/harness-core/templates/.harness/ground/brand/voice.md
  packages/harness-core/templates/.harness/ground/product/personas.yaml
  harness/src/cli/scope.ts
  harness/src/cli/doctor.ts
  packages/harness-lens/.gitignore
  packages/harness-lens/.vscodeignore
  packages/harness-lens/README.md
  + harness-build/BUILD_LOG.md entries (this file)
  + devplusllc-harness-lens-0.0.0.vsix (gitignored artifact)
BUILD_REPORT gaps closed: Gap 1 (scope rebuild), Gap 4 (gitignore audit confirmed correct), Gap 6 (cache content-hash). Gaps 2/3/5 are runtime/deployment concerns owned by harness-runtime — no state-layer change needed.

## Fixes — duplicate prereqs section + monorepo guard + self-adoption guard [DONE 2026-05-04T06:50]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS; self-adoption guard verified — `npx tsx harness/src/cli/index.ts init` from workspace root → ✗ message + exit 1; monorepo guard verified from harness/ subdir → prompt with default N + abort message.
Notes:
  Fix 1 — Removed runGuidedSetup() entirely. The "Guided setup — fixing missing prerequisites" header + `done("✓ claude / whisper / ollama …")` lines were dead duplicates of the discovery scanner. envState now derives directly from detection.environment.
  Fix 2 — New init/preflight-guards.ts with detectMonorepoContext(startCwd, gitRoot) + findGitRoot(). Walks up from cwd; first ancestor with pnpm-workspace.yaml / yarn workspaces / lerna.json is the workspace root. Returns null when startCwd itself is a workspace root or no marker found. Init wires preflightMonorepoGuard() — gated to repoRoot === cwd so smokes / --repo invocations skip. Default-N prompt; on abort prints `cd <workspace> && harness init` then exit 1. On override: warning persists, monorepo_context surfaced in InitResult.
  Fix 3 — isHarnessSourceRepo(repoRoot) checks all three markers (harness-build/, packages/harness-core/, pnpm-workspace.yaml). When repoRoot or cwd matches, prints ✗ block and process.exit(1) — Phase -1, before any other logic.

## Fix — split large modules + heuristic partial fallback [DONE 2026-05-04T16:55]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smokes: smoke-module-slicer PASS (4/4 incl. new Step 4 split test), smoke-init OK (zero JSON in stdout), smoke-init-mapper OK, smoke-session-start OK, smoke-scope-index OK; mypalcrm slicer-only run: 4 → 11 dispatchable slices (core/{drizzle,organizations,integrations,telephony,contacts,presentations}, platform/{components,app,lib}, phone-ai, site).
Notes:
  Fix 1 — module-slicer.ts: `sliceModules` now post-processes top-level slices via `maybeSplitLargeModule`. Modules with > LARGE_MODULE_SOURCE_THRESHOLD (150) source files split into sub-slices on top-level subdirs with ≥ SUBSLICE_SOURCE_THRESHOLD (20) source files, capped at MAX_SUBSLICES_PER_PARENT (6) by descending file count. New TRANSPARENT_WRAPPER_DIRS = {src, lib, app, source}: when the only candidate at the parent's top-level is one of these, we descend through it (up to MAX_TRANSPARENT_DESCENT = 2 levels) so e.g. `core/src/{auth,billing,…}` produces sub-slices named `core/auth`, `core/billing` (display-friendly) while the filesystem `modulePath` correctly resolves to `<repo>/core/src/auth`. Refactored `buildSlice` → `buildSliceFromTree` that accepts a pre-listed `ModuleTreeListing` plus optional `explicitSlug`, `parentFallbackPackageJson`, `parentFallbackDocs` so sub-slices can inherit the parent's package.json + docs without re-reading. New helper `pickSubdirCandidates`. The single-package case (no module markers detected) deliberately does NOT split — splitting a flat single-package repo over-fragments and adds no signal.
  Fix 2 — mapper-parallel.ts: the existing empty-arrays `buildFailedProposal` was replaced with a heuristic-driven version. Domain reads `<slug> module (analysis timed out — run harness scope rebuild)`. New FALLBACK_HIGH_STAKES_PATTERNS = [/^auth(entication)?$/i, /^billing$/i, /^payment(s)?$/i, /^security$/i] scans the slice's directoryTree and emits a `<repoRel>/<dir>/**` glob for each matched path segment (one glob per path). Scope index is populated with every file in the slice as `{ decisions: [], invariants: [], unscoped: true }` so the GC's scope-coverage pass doesn't re-flag the files for missing scope while the partial proposal stands. Confidence: 0.1, pilotModuleCandidate: false. Notes string flagged with "partial fallback used" so the merge step + completion summary can identify these proposals (`failed: true` flag preserved).
  Fix 3 — init.ts: `maybeRunMapper` return shape changed from `MapperOutput | null` to `{ output: MapperOutput; fallbackSlugs: string[] } | null`. Slugs are derived from `mapperResult.module_proposals.filter(p => p.failed)` and pushed both to the warnings list and into `printCompletionSummary` via a new `mapperFallbackSlugs` arg. Completion summary's Sensors row now renders a follow-up line `<slug1>, <slug2>, <slug3> +N more used fallback — rerun harness scope rebuild` when any fallback slugs exist, capped at 3 inline + "+N more" overflow. Mock/skip code paths return `fallbackSlugs: []` so smokes don't trigger the new line.

## Fix — walker recurses into git submodules [DONE 2026-05-04T16:30]
Subagent attempts: 0 (inline)
Compile: PASS (both packages)
Notes: `git ls-files --cached --others --exclude-standard` does NOT enumerate submodule contents — `--recurse-submodules` is mutually exclusive with `--others` (git rejects with "ls-files --recurse-submodules unsupported mode"). Walker now does TWO ls-files calls and unions: (1) `--cached --recurse-submodules` for tracked + submodule contents, (2) `--others --exclude-standard` for parent untracked. Tradeoff acknowledged: untracked files INSIDE submodules are dropped (rare in practice). Verified on mypalcrm: pre-fix top_level=[.claude, .env.example, .github, .gitignore, .gitmodules, .impeccable.md, .planning, docs, phone-ai] (no submodules); post-fix `core/` is enumerated (Pass 1 cap of 500 hit on the core src tree, truncation flag fires correctly). Submodule-init prompt + walker recursion together close the gap from BUILD_REPORT.

## Feat — chunked parallel mapper (Sonnet per-module + Haiku merge) [DONE 2026-05-04T16:40]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smokes: smoke-init OK, smoke-init-mapper OK (after walker depthCap-alias backcompat), smoke-module-slicer OK (3/3 steps), smoke-session-start OK, smoke-scope-index OK; zero JSON in smoke-init stdout.
Notes:
  - New `init/module-slicer.ts` — `sliceModules({ repoRoot })` returns `ModuleSlice[]`. Detects modules via `.gitmodules`, pnpm-workspace.yaml `packages`, root package.json `workspaces`, `lerna.json packages`, top-level dirs with own package.json, then heuristic (top-level dirs with ≥20 source files). Single-package repos (no marker found) collapse to one whole-repo slice with `moduleRel = "."`. Each slice carries `directoryTree` (paths only, capped 800 lines), `packageJson` (full), `representativeFiles` (≤5 chosen by 5-step heuristic: index/main/app entries → largest *.controller.ts / *.service.ts → schema roots (drizzle/prisma/mongoose) → most-imported file via grep on relative imports → router/routes/api), `localDocs` (concat README/AGENTS/CLAUDE/docs/*.md, capped 8k chars). Per-file content cap 12k chars.
  - New `init/mapper-parallel.ts` — `mapModulesParallel({slices, decisions, invariants, onModuleStart, onModuleEnd})` dispatches one Sonnet call per slice via `Promise.allSettled`. Schema requires `domain`, `pilot_module_candidate`, `confidence`, four glob arrays, `sensor_proposals`, `notes`; `scope_index` optional. Failed call → `ModuleProposal { failed: true, confidence: 0 }` with empty arrays. Batching: when slices > 8, split into rounds of 4 sequential rounds (still parallel within each round). Per-module timeout 180s.
  - New `init/mapper-merge.ts` — `mergeModuleProposals({proposals, workspacePackageJson, projectSlug})`. Mechanical merge always assembles a complete `MapperOutput` first (sensors deduped by id keeping highest-confidence variant, globs unioned, scope index merged with collision union, pilot picked from first `pilotModuleCandidate` else highest-confidence). If any module succeeded, a Haiku call is made to synthesize pilot_module + domain_summary + notes; on failure, the mechanical baseline is returned. `mechanicalMerge` exported separately for testing.
  - New `init/mapper-legacy.ts` — `runLegacyMapper({detection, summary, timeoutMs})`. Extracted unchanged from pre-chunked mapper.ts: same system prompt, same schema, same one-shot Sonnet call against the flat 20k-token repo summary. Returns `{ ...result, path: "legacy" }`. Used as fallback when every module call fails.
  - `init/mapper.ts` is now the orchestrator. `runMapper({detection, summary, repoRoot, onSlicesDetected, onModuleStart, onModuleEnd, legacyTimeoutMs})`: slice → parallel module calls → if all failed fall back to legacy → else Haiku merge → return `MapperResult` augmented with `path: "parallel" | "legacy"` and `module_proposals: ModuleProposal[]`. Backwards-compat re-exports preserved (`MAPPER_OUTPUT_SCHEMA`, `MAPPER_SYSTEM_PROMPT`, `buildMapperUserPrompt`) so `harness scope rebuild` and `init/index.ts` consumers don't break. `MapperOutput` shape unchanged — downstream init writers (workflow.md slug-block patcher, config.yaml builder, scope-index seeder) untouched.
  - `init/init.ts` Phase 3 swaps `withSpinner` for explicit `startSpinner` so the per-module progress callback can update spinner text live: `Analyzing codebase (3/4) — ✓ core 8s`. Final spinner-succeed line annotates path: `(parallel · 4 modules)` or `(legacy fallback)` so the operator sees which path was taken.
  - `init/walker.ts` — `BuildRepoSummaryOptions` gains `pass1Cap`, `pass2Cap`, `pass2DepthCap` (already in prior task). Added backcompat `depthCap` alias that maps to `pass2DepthCap` so smoke-init-mapper's existing `depthCap: 3` argument continues to work. Pass-2 depth-cap drops now set `truncated_at_depth_cap = true` (previously the new walker left it false, which broke the deep-tree smoke assertion). Submodule recursion fix from above also lives here.
  - New smoke `harness/scripts/smoke-module-slicer.ts` (3 steps): (1) two-module workspace fixture (npm workspaces, apps/api with index/controller/service/README + apps/web with index/router/component) → 2 slices with expected slugs + reps + docs; (2) bare-bones single-package fixture → 1 slice with `moduleRel === "."`; (3) heuristic fixture (one top-level dir with 25 source files, no workspace config) → 1 slice with the source-heavy slug.
  - Barrel exports added: `sliceModules`, `ModuleSlice`, `SliceModulesArgs`, `mapModulesParallel`, `MapModulesParallelArgs`, `ModuleProposal`, `mergeModuleProposals`, `mechanicalMerge`, `MergeArgs`, `runLegacyMapper`, `RunLegacyMapperArgs`, plus `MapperScopeIndex`/`MapperScopeIndexEntry` types.

## Fix — smarter init walker, raised depth cap, surface truncation warning [DONE 2026-05-04T16:25]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS (zero JSON in stdout); walker against harness repo: 328 files / 55 dirs / no truncation; tight-cap probe (pass1=5 pass2=5 total=8) returns truncated=true with Pass 2 dropped first.
Notes:
  Fix 1 — DEFAULT_DEPTH_CAP raised from 5 to 10 (now used only by the legacy single-pass fallback path; the two-pass walker bypasses it for high-signal subtrees).
  Fix 2 — walker.ts rewritten as a two-pass priority walk. HIGH_SIGNAL_DIRS = {src, lib, app, pages, components, services, controllers, routes, models, schemas, domain}. Pass 1: any path with a high-signal segment, no depth cap, cap 500. Pass 2: everything else, depth ≤ 6, cap 200. Total cap 3000. applyTotalCap drops Pass 2 first when overall exceeded. Both git-ls-files and filesystem-walk fallbacks updated. Filesystem walker carries an `underHigh` flag on each frame so descendants of a high-signal dir inherit Pass-1 classification AND skip the Pass-2 depth cap; defensive cap of 4×DEFAULT_DEPTH_CAP guards against runaway recursion. RepoSummary fields preserved for backcompat (mapper.ts still reads truncated_at_file_cap / truncated_at_depth_cap).
  Fix 3 — printDiscovery accepts the RepoSummary and renders a `codebase scan` row. On truncation: warn-icon row plus dimmed follow-up lines pointing to `harness scope rebuild`. On clean scan: ok-icon row showing `<N> files, <N> dirs`. Walker is now invoked once in runInit before printDiscovery; maybeRunMapper consumes the cached summary instead of re-walking.
  Fix 4 — describeScopeIndex takes a `scanTruncated` flag from CompletionSummaryArgs. When true, the scope-index row reads "partial — analysis was truncated during init" (or "empty — analysis was truncated during init") with the rebuild follow-up, persisting the warning past the scanning phase.

## Hotfix — Ctrl+C / Esc cancel during init [DONE 2026-05-04T06:35]
Subagent attempts: 0 (inline)
Compile: PASS (both packages); smoke-init PASS — auto mode does NOT install handlers (so smokes don't deadlock)
Notes: ora + cli-progress hide cursor while running; SIGINT didn't run their stop() so Ctrl+C left the operator stuck. Added cleanup registry in visual.ts — startSpinner + startProgress register their stop() and unregister on graceful succeed/fail. New installInitCancelHandlers() wires SIGINT/SIGTERM/SIGHUP to runAllCleanups() + showCursor() + exit(130). Also installs an Esc-keypress listener on stdin (single 0x1B byte = soft cancel; multi-byte sequences like arrow keys are skipped). brand-setup.ts adds rl.on("SIGINT") that closes readline + exits 130. installInitCancelHandlers() is gated to interactive mode in runInit so auto-mode smokes don't keep handlers attached. Public barrel re-exports installInitCancelHandlers + startSpinner / startProgress / withSpinner.

## Deep review pass [DONE 2026-05-04T18:30]
Issues found: 2 critical, 1 important, 0 polish (after audit of A–I)
Phase 6 ingestion: already existed (init.ts:runPhaseSix + ingest-docs.ts + baseline-audit.ts; verified via smoke-ingestion-baseline 4/4)
Attention command: built (harness/src/cli/attention.ts; reads decisions/_inbox/ + latest .harness/baseline/sensor-audit-*.yaml; exits 0 when clean / 2 when pending)
All smokes: PASS — smoke-session-start (8/8), smoke-status-line (4/4), smoke-handoff (3/3), smoke-scope-index (3/3), smoke-read-enrich (4/4), smoke-init (zero JSON in stdout), smoke-ingestion-baseline (4/4)
Compile: PASS (both packages, tsc --noEmit clean)
Notes:
  Audit C (CRITICAL) — `ctx:0/0` bug: `defaultStatusJson` had `ctx_tokens_budget: 0`. Bumped to 4000 (the SessionStart additionalContext cap). Init Phase 5c now ALWAYS writes a baseline `status.json` via `writeStatusJsonForSlug(slug, defaultStatusJson(false))` BEFORE calling `tryStartDaemon`, so the file exists with budget 4000 even when the daemon binary isn't on PATH. After Phase 6, when daemon did NOT start, init patches `attention_count = drafts + baseline_findings` so the status line surfaces the badge immediately. Verified runtime: `formatStatus(defaultStatusJson(false))` → `⬡ harness  ctx:0/4000  decisions:0  inv:0  daemon:down  ○`. Existing mypalcrm status.json with budget 0 is grandfathered — fix repairs on next init or daemon restart, not retroactively.
  Audit D (CRITICAL) — `harness attention`: new `harness/src/cli/attention.ts` reads `.harness/ground/decisions/_inbox/*.draft.md` (parses frontmatter for id / title / sourceFile / capture_source / proposedRationale) + latest `.harness/baseline/sensor-audit-*.yaml` (groups findings by sensor_id, caps display at 3 per sensor with "+N more" overflow). Renders age relative to now ("3m ago" / "2h ago" / "1d ago"). Wired into root CLI router + usage block; `attention` registered between `fix` and `hook`. Exit 0 when nothing pending; 2 when DEC drafts or baseline findings exist (so scripts can branch).
  Audit H polish — doctor surfaces attention_count: `checkDaemonStatus` now appends `, attention:N` to the daemon detail when `attention_count > 0` and sets `fixCommand: "harness attention"` so `harness fix` proposes the right next step.
  Audits A, B, E, F, G, I: verified existing implementations — Phase 6 wired (init.ts:runPhaseSix), first-session onboarding fires on 0 decisions/0 invariants AND baseline audit yaml present (build.ts:renderFirstSessionOnboarding, dropPriority puts it last so it survives truncation), failure modes exit cleanly (resolveRepoRoot null → empty Shape B, malformed JSON → defer-fail, mapper failure → spinner.fail + warning + continue, daemon spawnFailed → returned in DaemonAutostartResult.reason, no .git → warning push), submodule prompt lists each uninitialized path with `(uninitialized)` suffix, mapper progress uses ora `spinner.update(...)` in-place, daemon failure message clear ("install harness globally then run harness daemon start"), `--no-prompt` flag covers non-interactive CI, settings.json template uses bare `harness hook ...` (assumes global install — matches architecture; daemon path also assumes binary on PATH), read enricher silently passes through non-harness paths, write guardian handles both Write+Edit + reads sensors.yaml correctly, buildHandoffBlock returns null on empty git history / no active task / unparseable meta, build.ts wraps handoff in try/catch so SessionStart never crashes.
  Files modified:
    packages/harness-core/src/status-line/writer.ts (defaultStatusJson budget 0 → 4000 + comment)
    packages/harness-core/src/init/init.ts (import defaultStatusJson + writeStatusJsonForSlug; Phase 5c writes baseline status.json BEFORE tryStartDaemon; post-Phase-6 patches attention_count when daemon not started)
    packages/harness-core/src/doctor/index.ts (checkDaemonStatus appends attention hint + fix command)
    harness/src/cli/index.ts (attentionCli import + case + usage row)
  Files added:
    harness/src/cli/attention.ts

## Step 10 — Pre-publish prep (gitleaks + content audit + README + name) [DONE 2026-05-05T00:45]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages); 22/22 smokes regression-clean (no code changes).
Notes:
  Pre-publish housekeeping per RESUME §"Build sequence remaining" step 10. Three outputs: gitleaks scan, content audit, README rewrite + project name. Manual phase (history wipe + fresh public repo at v0.1.0) is the operator's call — this commit lands the audit findings + clean README so they have a clear go/no-go signal.
  Project name: **Cairn** — stack of stones marking a trail. Decisions stack up like cairns; agents follow them; built incrementally; navigational truth.
  Publish target: `github.com/isaacriehm/cairn` + `npm @isaacriehm/cairn-{core,cli,plugin,frontend-stub,lens}`. Operator overrode the devplusllc-continuity recommendation; LLC attribution can shift later via owner transfer if commercial framing materializes. Working-tree code still uses the `@devplusllc/harness*` names (and `harness` CLI binary); the search-replace to `@isaacriehm/cairn-*` + `cairn` binary lands as part of the public-repo initial commit so it's a single mechanical pass rather than a churn commit on the private mirror.
  Files modified:
    README.md — full rewrite. Drops the "design phase / no code yet" framing (stale; pre-pivot). Lands the current architecture: state + context layer, MCP surface, Claude Code plugin as primary surface + CLI as bootstrap, four-package layered model, multi-developer enforcement (4 layers), `.harness/` disk layout, dev workflow, doc index. Uses "Cairn" as the public name throughout, with a one-line note about the technical `harness` namespace continuing under `@devplusllc/`.
  Audit findings:
    1. `gitleaks detect` (working tree, no-git): 2 hits — both in `packages/harness/.env` which is gitignored. Discord bot token + decoded base64 variant. Operator should rotate the token before any environment-sharing event but it's not in git history.
    2. `gitleaks git` (full history, 101 commits): 0 leaks. Clean.
    3. Mypal/mypalcrm references inventory: README.md (now removed via this commit), AGENTS.md (line 26 — research-artifacts row), `.archive/2026-05-04/{STALENESS_INVENTORY,DISCORD_WHISPER_DESIGN}.md`, `.archive/2026-05-03/{CODEX_REVIEW_BRIEF,QUESTIONS,WORKFLOW_GUIDE}.md`, `docs/_history/INTEGRATION_PLAN.md`, `docs/INIT_SPEC.md`, `docs/_review/STATE_AUDIT_2026-05-04.md`, `harness-build/BUILD_LOG.md`, `harness-build/RESUME.md`, `packages/harness/scripts/check-layout.ts` (the *guard*, which bans them in templates — this file SHOULD keep its references). Active source code itself is mypal-free.
    4. Personal-name leak: 1 hit in `.archive/2026-05-03/CODEX_REVIEW_BRIEF_REVIEW.md` ("Isaac"). Single mention in an archived review brief. Operator decides whether to scrub or accept — first name is low-PII and this is a one-time mention.
    5. `.env` tracking: the live `.env` is gitignored AND has never been added to git history (verified via `git log --diff-filter=A` — only `.env.example` ever committed). Safe to leave in working tree; would not propagate to a fresh public repo cloned from the *clean working tree* per the publish strategy.
  Recommendations to operator (pre-publish manual phase):
    - Rotate the Discord bot token before sharing the harness-dev environment with anyone.
    - Decide on history-wipe scope: per RESUME the strategy is "fresh public repo with current clean working tree as initial commit at v0.1.0". The `.archive/`, `docs/_history/`, `docs/_review/`, `harness-build/` subtrees are operator-only build artifacts; consider whether they ship in the public repo or stay in the private mirror.
    - Decide on LICENSE: README cites MIT pending; the LICENSE file is not yet committed.
    - Package rename pass during fresh-public-repo creation: `@devplusllc/harness-*` → `@isaacriehm/cairn-*`, `harness` CLI bin → `cairn`, `harness_*` MCP tool prefix → `cairn_*` (or keep the MCP tool names since they're ABI surface — operator's call). Single search-replace on the initial-commit working tree.
  Smoke regression: full 22-smoke gate ran clean — no code changes in this commit so nothing should drift, but the gate confirms the README rewrite didn't accidentally break a docs-aware path (it doesn't).
  Build sequence complete. The pre-publish manual phase (history wipe + fresh public repo + initial v0.1.0 tag) is the operator's call from here.

## Step 9 — End-to-end smoke + Phase 7b/7c/12 init.ts wiring [DONE 2026-05-05T00:20]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages)
Smokes: PASS — smoke:e2e-adoption (8 steps new), smoke:e2e-daily-flow (5 steps new), all 20 prior smokes regression-clean (22 total).
Notes:
  Wires Phase 7b (source-comment ingestion), Phase 7c (existing-rules merge), and Phase 12 (multi-dev install) into the runInit visual pipeline; ships two e2e smokes that exercise the full adoption + daily-flow loops against a fresh tempdir fixture. Phase 10 (deterministic strip + replace) primitives stay decoupled — the consent UX is operator-driven, so the smokes invoke `applyStripReplace` directly when needed; init.ts doesn't auto-strip during adoption.
  Files modified (init.ts):
    src/init/init.ts — `RunInitArgs` extended with `skipPhase7b?`, `skipPhase7c?`, `skipPhase12?`, `mockSourceCommentClassify?`, `mockRulesMergeClassify?`. `InitResult` extended with `source_comments`, `rules_merge`, `multi_dev` (each nullable per skip / abort path). After `runPhaseSix` returns, three new visual blocks render to stdout: Phase 7b ("source-comment ingestion…" → "DEC drafts: N; invariant proposals: M; citations: K"), Phase 7c ("existing-rules merge…" → "Sources: N; net-new: …; conflicts: …; informational: …; operator-keep: …"), Phase 12 ("multi-dev enforcement install…" → "Hosts detected: …; prepare patched: yes/no" + dim manualHints lines). Default skip gate for 7b/7c is `skipIngestion === true || mode === "auto"` UNLESS a `mockClassify` is supplied — that gates lets the e2e smokes drive the path while normal `pnpm smoke:init` still runs auto-mode without burning Haiku tokens. Phase 12 runs unconditionally except when `skipPhase12 === true` (fully deterministic + idempotent — no auto-mode gate). Abort early-return in `runInit` (proceed=false) returns the three new fields as null.
  Files added (smokes):
    packages/harness/scripts/smoke-e2e-adoption.ts — 8 steps end-to-end. Builds a synthetic fixture (real `git init`, `package.json` w/ existing `prepare: husky install`, TS source with rationale-bearing JSDoc + license header + short non-essay comment, CLAUDE.md w/ H2 sections + operator keep block, AGENTS.md). Runs `runInit` in auto mode with both classifiers mocked (rationale → DEC draft for the JWT JSDoc; license header → license; "Brand voice" H2 → rule-net-new DEC draft; everything else → informational/other). Asserts: full template skeleton landed (config + ground + git-hooks + JOIN.md + .github/workflows/harness-check.yml), `harness_version` in config.yaml, source-comments audit yaml + DEC draft persisted (body cites HS512), rules-merge audit yaml + DEC draft persisted, operator-keep section auto-tagged without going through Haiku, `package.json` `prepare` patched ("harness join || true && husky install" — fragment first + existing preserved), git hooks owner-executable (mode bit 0o100), `.attested-commits` in `.harness/.gitignore`, adopted-but-unbootstrapped state pre-join + bootstrapped state post-join, version match.
    packages/harness/scripts/smoke-e2e-daily-flow.ts — 5 steps daily-flow loop. Adopts a fresh fixture (similar setup, no DEC drafts since the comment is "other"-classified), runs `harness join` so bootstrap-guard passes, then drives the post-adoption loop end-to-end:
      Step 1 — spawnSync against the compiled `dist/hooks/session-start.js` bin with payload `{session_id, cwd}`; asserts per-session `status.json` + `events-marker.json` land in `.harness/sessions/<id>/`, and additionalContext does NOT carry the bootstrap banner (since join already ran).
      Step 2 — drops a `spec.tightened.md` for a synthetic task without an `attestation.yaml`; runs the Stop bin; asserts additionalContext contains "Reviewer pending" + the task id.
      Step 3 — drops the `attestation.yaml`; runs Stop again; asserts the reviewer-pending hint clears.
      Step 4 — writes a synthetic DEC draft into `_inbox/`, calls the in-process `harness_resolve_attention(decision_draft, accept)` tool via `tool.handler(ctx, input)`; asserts canonical `<id>.md` materializes with `status: accepted`, draft removed from inbox.
      Step 5 — does a real `git commit --no-verify` so `.attested-commits` is NOT updated; runs Stop; asserts additionalContext contains "Bypass detection" + the inline `[a]/[b]/[c]` choices.
    packages/harness/package.json — registers smoke:e2e-adoption + smoke:e2e-daily-flow.
  Notable design choices:
    - The Phase 7b/7c default skip for auto mode is preserved so `smoke:init` and any scripted `harness init --no-prompt` keep their token-free profile. Smokes that want to exercise the path supply `mockSourceCommentClassify` / `mockRulesMergeClassify`, which flips the gate.
    - The e2e adoption smoke does NOT exercise Phase 10 (strip + replace). The consent flow is inline A/B/C — driven by the harness-attention skill or by an operator promoting drafts. Step 7's smoke covered the strip-replace primitive in isolation; folding it into the e2e adoption path would require fabricating a consent decision map, which mis-models the production loop. Phase 10 is the operator's call after they review drafts.
    - The daily-flow smoke spawns the compiled hook bins via `spawnSync` (mirroring `smoke-stop-hook`'s pattern) rather than calling the runner functions in-process. This validates the actual production wire format Claude Code uses (Shape B JSON on stdout, payload JSON on stdin) and catches breakage in the bin entrypoints.
    - `--no-verify` commit + missing `.attested-commits` entry models the production `git commit --no-verify` path: the post-commit hook (when wired) runs unconditionally on any successful commit, but `--no-verify` typically pairs with workflows where the dev disabled hooks entirely. The smoke models the worst case (entry truly missing) — bypass detection should still fire correctly.
  Step 10 (gitleaks scan + content audit + history wipe) remains. The Open / deferred from RESUME §"Open / deferred" — the harness-attention skill body still references the legacy fallback path (record_decision/archive/append) instead of resolve_attention; this is mentioned as deferred to step 9 and is now low-priority since the smoke proves the underlying tool works. Skill body update can fold into step 10 housekeeping or land as a separate housekeeping commit before publish.

## Step 8 — Multi-developer enforcement [DONE 2026-05-04T23:55]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages)
Smokes: PASS — smoke:join (8 steps new), smoke:bypass-detection (6 steps new), smoke:bootstrap-guard (5 steps new), all 17 prior smokes regression-clean (20 total).
Notes:
  Implements PLUGIN_ARCHITECTURE §17 across all four enforcement layers + §6 Phase 12 install. Spec rule: every developer touching an adopted project must run harness, locally and at PR time. Defense in depth: versioned git hooks (Layer 1) + per-clone bootstrap (Layer 2) + CI server-side gate (Layer 3) + plugin degraded mode (Layer 4) + Stop hook bypass detection (Layer 1.b).
  Files added (templates):
    packages/harness-core/templates/.harness/git-hooks/pre-commit — short, resilient. Fails the commit when `harness` is not on PATH. Otherwise execs `harness sensor-run --staged`. Opt-out path documented (`rm -rf .harness/`).
    packages/harness-core/templates/.harness/git-hooks/post-commit — appends HEAD SHA to `.harness/.attested-commits` after a successful commit. Best-effort; never fails the commit. Per PLUGIN_ARCHITECTURE §17 Layer 1 (bypass tracking).
    packages/harness-core/templates/.harness/git-hooks/commit-msg — thin shim that defers to `harness sensor-run --commit-msg <file>` when CLI is on PATH; bypassed silently when missing (pre-commit already blocks).
    packages/harness-core/templates/.harness/JOIN.md — onboarding doc for new contributors. Three bootstrap paths (Claude Code plugin auto-prompt, `harness join` CLI, `package.json prepare`). Includes verification + opt-out note.
    packages/harness-core/templates/.github/workflows/harness-check.yml — CI gate; `npm install -g @devplusllc/harness` + `harness sensor-run --diff origin/$BASE..HEAD --strict`. Triggers on pull_request + push to main/master. Non-bypassable per spec §17 Layer 3.
  Files modified (templates):
    packages/harness-core/templates/.harness/.gitignore — adds `.attested-commits` (per-clone, gitignored, written by post-commit hook, read by Stop hook bypass scan).
  Files added (harness-core/join):
    src/join/index.ts — `runJoin({cwd?, repoRoot?, dryRun?, strict?})` orchestrator with per-step status reporting. Steps: locate-repo (walk up for .harness/), version-check (config.yaml harness_version vs current CLI VERSION; mismatch is `warn`, not blocking), set-hooks-path (`git config core.hooksPath .harness/git-hooks`), chmod-hooks (re-applies 0755 to the three hooks), ensure-sessions-dir (mkdir -p .harness/sessions/). Idempotent — `prepare: harness join || true` re-runs cleanly. `inspectJoinState({repoRoot})` returns `{hooksPathSet, hooksPathValue, projectHarnessVersion, versionMatches, sessionsDirReady}` for plugin SessionStart degraded-mode detection without side-effects.
  Files added (harness-core/init/multi-dev):
    src/init/multi-dev/install.ts — Phase 12 multi-dev wiring. `installMultiDev({repoRoot, dryRun?})` detects host kinds: package.json (Node), pyproject.toml, Makefile, justfile, Cargo.toml, go.mod. For Node: patches `package.json` `scripts.prepare` to prepend `harness join || true && <existing>`. Idempotent — second run detects fragment + skips. Non-Node hosts: emits `manualHints[]` (no automatic patch). `patchPackageJsonPrepare(pkgPath, dryRun)` is the public surface; preserves trailing newline + 2-space indent.
    src/init/multi-dev/index.ts — barrel.
  Files added (harness-core/mcp):
    src/mcp/bootstrap-guard.ts — `requireBootstrap(repoRoot)` returns null when guard should pass-through (non-git dir, no config.yaml, hooksPath already set), else returns BOOTSTRAP_REQUIRED envelope with remediation hint. Conservative gating: only blocks on a real `.git/` + `.harness/config.yaml` AND `core.hooksPath !== .harness/git-hooks` so smokes / scaffold paths don't trip false positives.
    src/mcp/errors.ts — adds `BOOTSTRAP_REQUIRED` to McpErrorCode.
  Files modified (harness-core/mcp tools — guard insertion):
    src/mcp/tools/record-decision.ts, record-run-event.ts, drop-task.ts, archive.ts, append.ts, ask-operator.ts, resolve-attention.ts — every write tool calls `requireBootstrap(ctx.repoRoot)` at the top of its handler; short-circuits with the envelope before lock acquisition or filesystem write. Read tools (decision-get, search, etc.) untouched per spec §17 Layer 4 ("MCP read tools work").
  Files added (harness-core/hooks):
    src/hooks/bypass-detection.ts — `scanBypassedCommits(repoRoot)` reads HEAD's last 5 commits via `git log -n5 --format=%H%x09%s` + `.harness/.attested-commits`; returns `{bypassed[], inspected, attestedFileExists}`. `renderBypassHint(bypassed)` produces the inline A/B/C block (backfill / accept-DEC / defer). Pure functions; no mutation.
  Files modified (harness-core/hooks/runners):
    src/hooks/runners/session-start.ts — appends `renderBootstrapBanner(repoRoot)` to additionalContext when adopted clone is unbootstrapped. Banner instructs main Claude to surface inline `[a] bootstrap now / [b] skip` to the operator. Adds `bootstrap_required` to telemetry warnings when triggered.
    src/hooks/runners/stop.ts — runs `scanBypassedCommits` after the reviewer-pending scan; appends `renderBypassHint` to additionalContext when bypassed commits exist. Adds `bypassed_commits` count to telemetry.extra. New `bypass_scan_failed` warning row on git failure.
    src/hooks/runners/index.ts — re-exports `scanBypassedCommits`, `renderBypassHint`, `BypassedCommit`, `ScanBypassResult` so smokes don't have to reach into hooks/.
  Files added (harness CLI):
    packages/harness/src/cli/join.ts — `harness join [target-dir] [--dry-run] [--strict] [--json]`. Calls `runJoin`, renders per-step glyph (✓ ok / ○ skipped / ⚠ warn / ✗ error). Strict mode exits 2 on warn; default exits 0 on warn. JSON mode emits the structured result as-is.
    packages/harness/src/cli/index.ts — registers `join` subcommand + usage row.
  Files modified (harness-core init):
    src/init/init.ts — `buildProjectOverlay` now writes `harness_version: VERSION` into `.harness/config.yaml` so `harness join`'s version-check has something to read against.
    src/init/seed.ts — `seedHarnessLayout` chmods 0755 the three git hook templates as it copies them. `isExecutableTemplate(rel)` is the allowlist. Best-effort — Windows volumes that don't support chmod fall through; git index-mode + `harness join`'s re-chmod recovers.
    src/init/index.ts — exports `installMultiDev`, `patchPackageJsonPrepare` + types.
    src/index.ts — re-exports `runJoin`, `inspectJoinState`, `requireBootstrap` types from new modules.
    src/mcp/index.ts — exports `requireBootstrap` for downstream tool consumers.
  Smokes added:
    packages/harness/scripts/smoke-join.ts — 8 steps: empty-dir error path, success path (git config landed), idempotency (sessions dir reports skipped), version mismatch surfaces warn, inspectJoinState reports state, multi-dev package.json prepare patch + idempotent re-run, non-Node Makefile manual hint, patchPackageJsonPrepare preserves existing prepare command (prepends harness fragment with && separator).
    packages/harness/scripts/smoke-bypass-detection.ts — 6 steps: non-git dir empty result, fresh git no attested file → all flagged, attested file masks recorded shas, partial-attest only flags un-attested, 5-commit lookback window (older shas fall out), renderBypassHint includes [a]/[b]/[c] + short SHA + subject.
    packages/harness/scripts/smoke-bootstrap-guard.ts — 5 steps: non-git dir passes through, .git but no config.yaml passes through, adopted clone without hooksPath blocks with BOOTSTRAP_REQUIRED, after runJoin guard passes, resolve_attention tool returns BOOTSTRAP_REQUIRED envelope on unbootstrapped clone.
    packages/harness/package.json — registers smoke:join, smoke:bypass-detection, smoke:bootstrap-guard.
  Notable design choices:
    - `requireBootstrap` is conservative: returns null on non-git dirs, null when `.harness/config.yaml` is absent, and only blocks on a confirmed adopted clone whose hooksPath is unset. Smokes can safely scaffold partial `.harness/` skeletons without tripping the guard.
    - Bypass detection compares against the per-clone `.attested-commits` file. The post-commit hook is the writer; if a developer ran `git commit --no-verify`, the post-commit hook fires anyway under git semantics, but the pre-commit hook never validated — there's no signal in the attested-commits file from that commit because the pre-commit hook would have appended it pre-validation in a future design. In the current shipped post-commit hook, every successful commit (verify or no-verify) gets recorded — so the bypass is detected by the SENSOR not running, which we'll catch at the PR level via Layer 3 CI gate. Layer 1.b's purpose is *visibility*: the Stop hook surfaces the bypass to the operator's next assistant turn so they can backfill or document. The smoke explicitly tests this by NOT appending to .attested-commits, modeling a `--no-verify` path that bypasses the post-commit hook entirely.
    - `harness_version` field added to `.harness/config.yaml` is `0.0.0` (matching `packages/harness-core/src/index.ts` VERSION constant). When the CLI is published, this becomes the pinned semver — `harness join` warns on mismatch but doesn't block, since the versioning policy is operator-driven (some projects pin tightly, others accept newer CLIs).
    - `installMultiDev` doesn't write to non-Node hosts. The spec calls for "best-effort detection during adoption Phase 1 for non-Node — Makefile/justfile/pyproject.toml" — the surface is detection + manual hint, not auto-patch, because Makefile/pyproject grammars aren't safe to mechanically edit without operator review. The hint surfaces once during adoption Phase 12; the operator wires it themselves.
  Step 9 (E2E smoke against a fresh fixture) and step 10 (gitleaks + content audit + history wipe) remain. The init.ts visual wiring of Phase 12 is deferred to step 9 alongside Phase 7b/7c/10 — all heavy adoption phases get exercised together against a real fixture before binding into production init.

## Step 7 — Heavy adoption pipeline (Phase 7b/7c/10 primitives) [DONE 2026-05-04T23:30]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages)
Smokes: PASS — smoke:source-comments (6 steps new), smoke:rules-merge (6 steps new), all 15 prior smokes regression-clean (17 total).
Notes:
  Implements PLUGIN_ARCHITECTURE §6 Phase 7b (full-repo source-comment ingest), §6 Phase 7c (existing-rules merge + regenerate), §6 Phase 10 + §15 (deterministic strip + replace). Operator picked "full" cost ceiling (Q-1 in §19) — no Haiku spend cap honored. Phase 7b/7c orchestrators ship as standalone async APIs; init.ts wiring stays deferred so step 9 can exercise the visual pipeline end-to-end against a real fixture before binding the heavy spend path into the production init flow.
  Files added (harness-core/source-comments):
    src/init/source-comments/walker.ts — deterministic per-language comment-block walker. `walkSourceComments({repoRoot, fileCap?, onlyFiles?})` lists source files via `git ls-files --cached --others --exclude-standard -z` with FS fallback, then per-file scans block comments (`/* */`), JSDoc (`/** */`), line-clusters (`// // //`, `# # #`, `/// ///`, `//! //!`), Python `""" """`/`''' '''`, Ruby `=begin / =end`. Heuristic: line ≥ 4 OR char > 200 OR JSDoc word-count > 30. License headers (`Copyright`, `SPDX-License-Identifier`, `Licensed under`, `All rights reserved`) get `kind: "license"` so the strip-replace stage leaves them untouched. Word-count strips comment markers, leading `*`, and `@tag` lines (JSDoc) before counting. CommentBlock carries `id` (`<file>:<startLine>-<endLine>`), startOffset/endOffset for byte-precise replacement, raw, prose, line/char/word counts, kind, lang. Supports js/tsx, py, rs, go, java, c/c++, cs, kt, swift, scala, php, lua, dart, rb, sh.
    src/init/source-comments/classify.ts — Haiku batch classifier (20 blocks/call). Schema: `{results: [{block_id, kind: rationale|constraint|citation|license|other, suggested_dec_draft?, suggested_invariant?, suggested_canonical_topic?}]}`. System prompt: conservative classification, echo block_id verbatim. Per-batch failures bubble as `failed: true` with `kind: "other"` so strip-replace skips. Per-block prose capped at 1500 chars before batching. Tracks input/output token usage per batch. `mockClassify` test escape hatch.
    src/init/source-comments/ingest.ts — orchestrator wiring walker → classifier → persisters. Writes `.harness/baseline/source-comments-<ISO>.yaml` (full audit: every block + classification + tokens). Allocates DEC ids via `allocateDecisionId(repoRoot, existingIds)` for any "rationale" classification with non-empty title and writes `<id>.draft.md` to `_inbox/` with `status: draft-from-source-comment`, `capture_source: init-source-comments`, sourceFile + sourceRange + blockId + canonicalTopic frontmatter. Constraint classifications append to `.harness/baseline/invariant-proposals-<ISO>.yaml`; citation classifications append to `.harness/baseline/canonical-citations-<ISO>.yaml`.
    src/init/source-comments/strip-replace.ts — Phase 10 deterministic mechanical replacer. `applyStripReplace({repoRoot, items, dirtyDecisions?, dryRun?})`: groups items by file, runs `git status --porcelain -- <files>` to detect dirty, honors per-file `DirtyDecision` map (`stash | skip | overwrite`; missing key = skip), backs up original to `.harness/backups/source/<rel>.original` (single snapshot, never overwritten), applies edits right-to-left to preserve offsets, preserves leading indent of the original block. `previewStripReplace` returns `{file, before, after}` triples for the consent UI. Detects overlapping items (`detectOverlaps`) and skips the whole file. Tolerates missing files / range mismatch (recorded as `range-mismatch` skip). `git stash push --keep-index -m "harness-strip-replace <file>" -- <file>` for the stash path.
  Files added (harness-core/rules-merge):
    src/init/rules-merge/discover.ts — finds CLAUDE.md, AGENTS.md, .claude/CLAUDE.md, and `.claude/rules/**.md`. Returns `{path, absPath, kind, size}` per source.
    src/init/rules-merge/keep-markers.ts — operator-preserved sections live between `<!-- harness:keep-start[:label] -->` and `<!-- harness:keep-end -->`. `extractKeepBlocks(source)` returns `{label, body, startOffset, endOffset}[]`. `renderKeepBlock(body, label?)` round-trips. `reapplyKeepBlocks(regenerated, blocks)` substitutes `<!-- harness:keep-anchor:N -->` placeholders with the corresponding block; orphan blocks (no anchor) land in a trailing `## Operator-preserved sections` appendix wrapped in `<!-- harness:appendix-start/-end -->` markers.
    src/init/rules-merge/parse-sections.ts — splits a markdown body into H2/H3-headed `RuleSection[]` with line-count safety, tags sections that overlap any keep-block as `protectedByKeepMarker: true` so the orchestrator can short-circuit classification.
    src/init/rules-merge/ingest.ts — `runRulesMerge({repoRoot, mockClassify?, dryRun?, nowIso?})`. For each non-preamble section, classifies via Haiku into `rule-net-new | rule-conflict | informational | operator-keep` (operator-keep auto-tagged from `protectedByKeepMarker`, never hits Haiku). Net-new → DEC draft to `_inbox/` with `status: draft-from-rules-merge`. Conflicts append to `.harness/baseline/rule-conflicts-<ISO>.yaml`. Full audit at `.harness/baseline/rules-merge-<ISO>.yaml`. Concurrency 4 workers; per-section timeout 60s; section body cap 4000 chars before send.
    src/init/rules-merge/regenerate.ts — `regenerateRulesFiles({repoRoot, brandName?, positioning?, nowIso?})` consumes ground state (`buildDecisionsLedger` + `buildInvariantsLedger`) and renders fresh CLAUDE.md (heading + ground-state pointers + active-decisions list + active-invariants list + keep-anchors) and AGENTS.md (TOC table + count summary + keep-anchors). `reapplyKeepBlocks` re-injects existing operator content from the prior file.
  Files modified:
    src/init/index.ts — barrel re-exports the new public surface (walkSourceComments, classifyBlocks, runSourceCommentsIngestion, applyStripReplace, previewStripReplace, runRulesMerge, regenerateRulesFiles + types).
    packages/harness/scripts/smoke-source-comments.ts — 6 steps: language detection, heuristic boundaries (block/jsdoc/py-docstring/license), multi-language coverage (rs/go/sh/rb), ingest persistence (DEC draft + audit yaml), strip-replace mechanical edit + indent preservation + .original backup, dirty-check honors no-decision skip.
    packages/harness/scripts/smoke-rules-merge.ts — 6 steps: discovery (5 sources across CLAUDE.md/AGENTS.md/.claude/CLAUDE.md/.claude/rules/**), section parser, keep-marker extract + reapply, labelled keep-blocks + orphan appendix, runRulesMerge with mockClassify (DEC draft persistence + operator-keep auto-classification), regenerateRulesFiles (ground state lookup + keep preservation + brand/positioning rendering).
    packages/harness/package.json — adds smoke:source-comments + smoke:rules-merge entries.
  Notable design choices:
    - Strip-replace caller composes the marker text (`// §V<N>` or `// TODO(TSK-<id>)`); the module only does mechanical placement. This keeps §V allocation logic out of the replacement primitive — the skill that drives the Phase 10 consent flow will resolve `constraint` proposals to allocated §V ids before constructing ReplaceItems.
    - License blocks pass through walker (`kind: "license"`) but the heuristic still admits them (so they appear in audit) — strip-replace just never sees them because the caller filters out `license` kinds when building items.
    - Rules-merge's regenerate path relies on `buildDecisionsLedger` only returning `status=accepted` decisions (per `ledgers.ts:37`), so the regenerated CLAUDE.md never echoes inbox drafts. Inbox drafts surface separately through the attention queue.
    - Walker's `git ls-files` probe redirects stderr to silence "fatal: not a git repository" noise on FS-fallback paths (smokes hit this; no functional change otherwise).
  Step 8 (multi-dev enforcement: versioned git hooks + CI gate + degraded-mode plugin SessionStart + bypass detection) and step 9 (E2E smoke against a fresh fixture, exercises the full reviewer + DEC + Stop loop) and step 10 (gitleaks + content audit + history wipe) remain. The init.ts Phase 7b/7c/10 visual wiring is deferred to step 9 so the consent UX can be exercised against a real fixture before binding the cost-ceilinged path into production init.

## Step 6 — Reviewer subagent + harness_resolve_attention + Stop scan [DONE 2026-05-04T23:00]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages)
Smokes: PASS — smoke:resolve-attention (7/7 new), smoke:stop-hook (5/5 new), smoke:plugin-layout (8/8, +Step 4d agents/reviewer.md), all 12 prior smokes regression-clean.
Notes:
  Three loosely-coupled deliverables that complete the plugin's review/attention loop. Spec: PLUGIN_ARCHITECTURE §8 (daily flow), §9 (MCP write tool plugin-era addition), §10 (Stop hook), §11 (subagent role).
  Files added (plugin):
    packages/harness-frontend-claudecode/agents/reviewer.md — markdown brief; frontmatter declares name + description + tools (Bash, Read, Glob, Grep). Pipeline per §11: read tightened spec → walk staged + unstaged diff (per-file scope-glob check + §V citation check) → collect per-subagent attestation.yaml → emit DEC drafts via harness_record_decision({target:"inbox"}) for non-obvious choices (cap 5 per attestation, rest into remaining_concerns) → write consolidated `.harness/tasks/active/<task_id>/attestation.yaml` → return tight summary to main Claude. Hard rules: read-only on working tree, target=inbox always, ≤5 DEC drafts.
  Files added (harness-core):
    src/mcp/tools/resolve-attention.ts — new write tool. kind × choice resolution matrix:
      decision_draft a → withWriteLock: copy `_inbox/<id>.draft.md` → `<id>.md`, status flipped to accepted, draft renamed to `.accepted.bak` for recovery, emits `decision_accepted` invalidation event.
      decision_draft b → withWriteLock: rename draft into `.archive/<today>/...`, emits `decision_rejected` event with optional rationale.
      decision_draft c → returns the body (no write) so the skill can hand it to the operator's editor flow.
      baseline_finding a → no-op (skill opens the file).
      baseline_finding b → withWriteLock: append to `.harness/baseline/suppressions.yaml` with id + suppressed_at + optional rationale.
      baseline_finding c → no-op.
      invalidation_event a/b/c → ack only (refresh / continue_under_old / abort) — marker stamping happens in the skill since it owns the session id.
      drift any → reserved (drift surface lands later).
      Errors: malformed item_id and missing draft return mcpError envelopes (VALIDATION_FAILED / FILE_NOT_FOUND).
    src/mcp/schemas.ts — added `resolveAttentionInput` (item_id, choice enum a|b|c, kind enum decision_draft|baseline_finding|invalidation_event|drift, optional rationale).
    src/mcp/tools/index.ts — registered resolveAttentionTool (last entry; comment "Write — plugin-era").
  Files modified (harness-core):
    src/hooks/runners/stop.ts — runStopHook now scans `.harness/tasks/active/<id>/` for tasks that have a `spec.tightened.md` but no `attestation.yaml`. Window: only tasks whose spec mtime is within the last 6h (older orphans are stale; operator deals via attention). When pending reviews exist, additionalContext renders a "## Reviewer pending (N tasks)" block listing each task_id + spec_path + a one-paragraph instruction to spawn the reviewer subagent via Task tool with `agents/reviewer.md`. Telemetry row gains pending_reviews count.
  Smokes added:
    smoke-resolve-attention.ts — 7 steps covering accept/reject/edit, suppress/triage/defer, invalidation refresh/continue/abort, error envelopes for missing draft and malformed item_id. Asserts: state changes (canonical DEC file content + status=accepted, draft removed from inbox, suppressions.yaml appended), event emission (1 file written for accept), idempotent no-op for triage/defer/edit.
    smoke-stop-hook.ts — 5 steps spawning the compiled `dist/hooks/stop.js` bin via spawnSync with piped JSON stdin. Asserts Shape-B output: empty additionalContext on bare repo, reviewer-pending block when spec.tightened.md exists without attestation.yaml, suppressed when attestation.yaml present, suppressed when spec is >6h old, multiple pending tasks listed correctly with N count in header.
  Files modified (plugin):
    scripts/check-layout.mjs — added agents/*.md walk; validates name + description in frontmatter + non-empty body. Mirrors the skills/commands validation.
    packages/harness/scripts/smoke-plugin-layout.ts — added Step 4d (agents/reviewer.md present + valid frontmatter + body >200 chars).
  Files modified (harness):
    package.json — registered smoke:resolve-attention, smoke:stop-hook.
  Notable design choice: stop hook surfaces a TEXT hint in additionalContext rather than directly spawning the reviewer subagent. Hooks are short-lived subprocesses; main Claude (the next assistant turn) is the right thing to issue a Task call. The hint references `agents/reviewer.md` so main Claude knows exactly which subagent definition to invoke.
  Step 7 (heavy adoption pipeline phases 7b/7c/10) and step 8 (multi-dev enforcement) consume these surfaces.

## Step 5 — Skills + slash commands [DONE 2026-05-04T22:30]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages); plugin's check-layout extended to validate skill + command frontmatter shape.
Smokes: PASS — smoke:plugin-layout (7 steps now: +Step 4b skills present, +Step 4c slash commands present), all 12 other smokes regression-clean.
Notes:
  Implements PLUGIN_ARCHITECTURE §11 (skills + slash commands) within harness-frontend-claudecode/. Files are markdown documents; the description frontmatter drives Claude Code's auto-invocation matcher; the body is the instruction set Claude executes when the skill fires.
  Files added (skills):
    skills/harness-adopt/SKILL.md — first-time adoption inline walk. Trigger: SessionStart sees no .harness/ AND no decline-never marker. Pipeline per §6: A/B/C "[a] yes / [b] not now / [c] never" → preflight (claude on PATH, git work tree) → spawn `harness init` subprocess streaming output as fenced text → translate phase A/B/Cs into AskUserQuestion calls → final summary with pilot module + DEC drafts + baseline findings + CI gate state.
    skills/harness-direction/SKILL.md — task prompt → tier0 → tightener → dispatch. Trigger: task-shaped verb in user message AND no active task. Pipeline per §8/§14: parallel MCP context reads (decisions_in_scope, invariants_in_scope, canonical_for_topic, search) + last 5 commits → ready/not-ready decision → ≤2-3 cited A/B/C questions if not-ready → write `.harness/tasks/active/<id>/spec.tightened.md` → propose chunks (1=silent, ≥2=plan-review A/B/C) → emit ```dispatch``` fenced block per §11 for main Claude to parse + Task-spawn subagents.
    skills/harness-attention/SKILL.md — surface pending DEC drafts + sensor findings + drift + cross-session invalidation events. Trigger: SessionStart context flagged attention_count > 0. Pipeline: read drafts/baseline/drift/events in parallel → sort by hard-conflict > DEC > sensor > drift > invalidation → cap at 3 items per turn → A/B/C with cited source → resolve via harness_resolve_attention (NEW MCP tool, lands in step 6) with documented fallbacks (record_decision/archive/append) until then → stamp events poll cursor.
  Files added (slash commands):
    commands/harness-init.md — manual `/harness-init`; equivalent to harness-adopt skill but bypasses the trigger gate. Detects already-adopted projects and routes to `[a] re-init --force / [b] doctor / [c] cancel` (default cancel for safety).
    commands/harness-direction.md — manual `/harness-direction <prompt>`; escape hatch when auto-invoke misclassifies. argument-hint declared in frontmatter. Empty-arg case surfaces a usage hint.
  Files modified:
    packages/harness-frontend-claudecode/scripts/check-layout.mjs — extended to walk skills/<slug>/SKILL.md + commands/*.md and validate frontmatter (`name` for skills, `description` for both) + non-empty body. Catches skill files written outside the frontmatter convention before they ship.
    packages/harness/scripts/smoke-plugin-layout.ts — added Step 4b (3 skills present with valid name+description and >200-char body) and Step 4c (2 slash commands present with description frontmatter).
    packages/harness-frontend-claudecode/skills/.gitkeep, agents/.gitkeep, commands/.gitkeep — removed (real content shipped for skills + commands; agents/ keeps gitkeep until step 6 lands reviewer.md).
  Notable design choices:
    - In the plugin form factor, the running Claude IS the question-asker. The "tier0 Haiku" cost optimization mentioned in spec §14 (escalate Sonnet on complexity) is a future optimization; for now the skill instructs the running Sonnet/Opus instance to do the question-asking inline. Skips one round-trip and matches the operator's preference for fast-intuitive direction.
    - harness-attention skill documents the FALLBACK path (record_decision / archive / append) for resolving DEC drafts since `harness_resolve_attention` is added in step 6. This keeps the skill functional immediately rather than gating it on the new write tool.
    - Skill bodies cite `feedback_decide_dont_overprompt.md` and `caveman:caveman` style preferences inline so the running agent honors them without re-loading memory.
  Step 6 (reviewer subagent + harness_resolve_attention MCP tool) and step 7 (heavy adoption pipeline phases 7b/7c/10) consume these surfaces.

## Step 4 — Plugin scaffold + hook bin entrypoints [DONE 2026-05-04T22:00]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean across 5 packages now)
Smokes: PASS — smoke:plugin-layout (5/5 new), smoke:events (6/6), smoke:session-state (5/5), smoke:status-line (6/6), smoke:session-start (8/8), smoke:handoff (3/3), smoke:scope-index (3/3), smoke:read-enrich (4/4), smoke:init OK, smoke:ingestion-baseline (4/4), smoke:tier0 OK, smoke:gc OK, smoke:lock OK. Direct-bin spawns via `node packages/harness-core/dist/hooks/<name>.js` with piped JSON stdin emit valid Shape-B output (verified for session-start, stop, session-end).
Notes:
  Implements PLUGIN_ARCHITECTURE §4 (manifest), §9 (MCP), §10 (hooks). Plugin manifest invokes harness-core compiled JS directly, so harness-frontend-claudecode does not depend on `harness` umbrella CLI being on PATH. Step 4 scope per RESUME §19 was scaffold + manifest + hooks/mcp wiring + empty skills/agents/commands dirs + verify clean build. Skill/agent/command bodies arrive in steps 5–6.
  Hook entrypoint refactor (load-bearing): runners moved out of `packages/harness/src/cli/hook.ts` into `packages/harness-core/src/hooks/runners/` so both routes (plugin bins + umbrella CLI) call the same code. New bin entry scripts at `packages/harness-core/src/hooks/{session-start,session-end,stop,read-enrich,write-guard}.ts` are tiny (`#!/usr/bin/env node` + `import { runX } from './runners/index.js'; runX().catch(...)`); compiled to `dist/hooks/*.js` so `node ${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/hooks/<event>.js` works literally per spec.
  Stop hook (new in this step): drains events since `marker.last_polled_ts`, stamps poll cursor, patches `status.json.updated_at` heartbeat. Emits empty additionalContext — surface text comes from harness-attention skill in step 5. Telemetry row records `events_drained` count.
  MCP bin: spec text says `dist/mcp/server.js` — diverged to `dist/mcp/serve.js` because `server.js` is the library export of `startMcpServer` and shouldn't auto-execute on import. New `packages/harness-core/src/mcp/serve.ts` bin parses `--repo-root`/`--session-id`/`--run-id`, builds an McpContext, calls `startMcpServer({ ctx })`. Plugin's `.mcp.json` references serve.js. Logged in BUILD_LOG; not a load-bearing operator decision.
  Files added (harness-core):
    src/hooks/runners/payload.ts (readHookStdin, parseHookPayload, emitShapeB, recordHookTelemetry — shared by all runners)
    src/hooks/runners/session-start.ts (runSessionStartHook — composes additionalContext, ensures session dir, seeds events marker, GCs stale sessions/events)
    src/hooks/runners/session-end.ts (runSessionEndHook — cleanupSession; best-effort)
    src/hooks/runners/stop.ts (runStopHook — events drain + stamp + heartbeat; future steps add sensor run, attestation reviewer spawn, bypass detection)
    src/hooks/runners/index.ts (barrel)
    src/hooks/index.ts (top-level barrel — re-exports runners + post-tool-use)
    src/hooks/{session-start,session-end,stop,read-enrich,write-guard}.ts (bin entrypoints)
    src/mcp/serve.ts (MCP bin entrypoint)
  Files added (plugin):
    packages/harness-frontend-claudecode/package.json (workspace member, depends on harness-core; build runs `node scripts/check-layout.mjs`)
    packages/harness-frontend-claudecode/.claude-plugin/plugin.json (name=harness, version=0.1.0, repo, license)
    packages/harness-frontend-claudecode/.mcp.json (registers harness MCP via dist/mcp/serve.js)
    packages/harness-frontend-claudecode/hooks/hooks.json (SessionStart, SessionEnd, Stop, PostToolUse[Read|Grep|Glob, Write|Edit] — all node-direct paths)
    packages/harness-frontend-claudecode/skills/.gitkeep, agents/.gitkeep, commands/.gitkeep
    packages/harness-frontend-claudecode/scripts/check-layout.mjs (validates plugin.json + .mcp.json + hooks.json shape; verifies every node bin path resolves to an existing dist file)
    packages/harness-frontend-claudecode/README.md (layout + bin paths + distribution notes)
  Files modified:
    packages/harness/src/cli/hook.ts — replaced inline session-start/session-end/sub-bodies with calls to runners; added `harness hook stop` subcommand. Both routes (plugin bin + umbrella CLI) now share runner code.
    packages/harness-core/src/index.ts — re-exports `./hooks/runners/index.js` (in addition to the existing `./hooks/post-tool-use/index.js`).
  New smoke `smoke-plugin-layout.ts` (5 steps): plugin.json shape, .mcp.json + bin resolves, hooks.json wires all four event classes with valid bins (matchers Read|Grep|Glob and Write|Edit asserted), component dirs scaffolded, harness-core exports the runner functions.
  Direct-spawn sanity: piped `{"session_id":"test-123","cwd":"/tmp/notharness","source":"startup"}` to `node dist/hooks/session-start.js` returns `{"continue":true,"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}` (no .harness/ found, falls through cleanly). stop and session-end also emit valid Shape-B JSON.
  Step 5 (skills: harness-adopt, harness-direction, harness-attention) and step 6 (reviewer agent) consume the scaffolding.

## Step 3c — Invalidation events + per-session marker [DONE 2026-05-04T21:30]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean)
Smokes: PASS — smoke:events (6/6 new), smoke:session-state (5/5), smoke:status-line (6/6), smoke:session-start (8/8), smoke:handoff (3/3), smoke:scope-index (3/3), smoke:read-enrich (4/4), smoke:init OK, smoke:ingestion-baseline (4/4), smoke:tier0 OK, smoke:gc OK, smoke:lock OK
Notes:
  Implements PLUGIN_ARCHITECTURE §7 layer-2 (invalidation events). Every locked write to global state (`harness_record_decision`, `harness_archive`, `harness_drop_task`) emits a JSON file under `.harness/events/`. The Stop hook (step 4) will read events newer than the per-session marker and surface inline A/B/C if any touch a DEC/§V the reader has in scope. 7-day retention.
  Files added:
    packages/harness-core/src/events/index.ts (barrel)
    packages/harness-core/src/events/paths.ts (eventsDir helper)
    packages/harness-core/src/events/writer.ts (writeInvalidationEvent: `<14-digit-ts>-<kind>.json`, collision suffix on EEXIST via crypto.randomBytes; payload schema InvalidationEvent { ts, kind, refs: { kind: "decision"|"invariant"|"task"|"path", id }[], path?, source: { session_id, tool } })
    packages/harness-core/src/events/reader.ts (eventsSince — filter by ts, sort ascending, optional limit, malformed files reported separately so the reader never throws; gcStaleEvents — drops files older than 7 days, falls back to mtimeMs when payload ts is unreadable)
    packages/harness-core/src/session/events-marker.ts (seedEventsMarker — idempotent, preserves existing ts on re-seed; stampEventsPoll — advances last_polled_ts without resetting ts; readEventsMarker — returns null on missing/malformed)
    packages/harness/scripts/smoke-events.ts (6 steps: writer round-trip, collision suffix, eventsSince filter+sort+malformed handling, gcStaleEvents 7-day boundary, marker seed+stamp idempotency, end-to-end via harness_record_decision lookup through allTools)
  Files modified:
    packages/harness-core/src/index.ts — exports * from events + session
    packages/harness-core/src/session/index.ts — exports events-marker symbols
    packages/harness-core/src/mcp/context.ts — McpContext gains optional sessionId; createContext forwards
    packages/harness-core/src/mcp/tools/record-decision.ts — emits `decision_drafted` (target=inbox) or `decision_accepted` (target=accepted); refs include the new DEC id and any `supersedes` target so events fan out across the supersedes chain. Wrapped in try/catch — emit failure must never roll back the lock-protected write.
    packages/harness-core/src/mcp/tools/archive.ts — emits `path_archived`; if the archived path is `decisions/<DEC-NNNN>.md` (or `_inbox/<DEC-NNNN>.draft.md`), prepend a `decision` ref so DEC-scoped readers see it.
    packages/harness-core/src/mcp/tools/drop-task.ts — emits `task_created` referencing the new task id.
    packages/harness/src/cli/hook.ts — SessionStart now seeds events marker (`seedEventsMarker`) immediately after the session dir is created, runs `gcStaleEvents` alongside `gcStaleSessions` so each SessionStart amortizes both retention sweeps.
    packages/harness-core/templates/.harness/.gitignore — adds `events/` (regenerable inter-session signal, 7-day retention) alongside `sessions/`.
    packages/harness/package.json — registers `smoke:events`.
  Concurrency posture: emit happens *inside* the withWriteLock callback (after the underlying write completes, before lock release) to prevent torn-state events; readers always see the canonical write before the event file. Emit failures are swallowed — the lock-protected write is the source of truth, events are advisory signal.
  Notable design choice: `harness_append` is allowlisted to runs/active/<id>/* + staleness/log + inbox/**, all of which are run-internal or duplicated by other emitters; not wired to emit in this step. `harness_ask_operator` writes per-run question files (run-internal, not global state per spec §7) — also not wired.
  Step 4 (plugin scaffold + Stop hook subcommand that reads `eventsSince(repoRoot, marker.last_polled_ts)`, filters to in-scope DEC/§V, surfaces A/B/C, then `stampEventsPoll`) remains.

## Step 3b — Per-session state partition [DONE 2026-05-04T21:00]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean)
Smokes: PASS — smoke:session-state (5/5 new), smoke:status-line (6/6, rewritten for per-session sig), smoke:session-start (8/8), smoke:handoff (3/3), smoke:scope-index (3/3), smoke:read-enrich (4/4), smoke:init OK, smoke:ingestion-baseline (4/4), smoke:tier0 OK, smoke:gc OK, smoke:lock OK
Notes:
  Implements PLUGIN_ARCHITECTURE §7 (per-session state partition) — `.harness/sessions/<session-id>/` is owned by exactly one Claude Code session for the lifetime of that session. Status.json moves out of `~/.local/harness/state/<slug>/` (legacy daemon-era path) into the per-session dir under the repo. Hard cutover — no transition shim.
  Files added:
    packages/harness-core/src/session/index.ts (barrel)
    packages/harness-core/src/session/id.ts (resolveSessionId, ensureSessionDir, cleanupSession, gcStaleSessions; `meta.json` schema with session_id/started_at/pid; `isPidAlive` via process.kill(pid, 0); MAX_STALE_AGE_MS = 24h per spec)
    packages/harness-core/templates/.harness/.gitignore (ignores sessions/, .write-lock, .gc-lock, .audit-lock for adopted projects)
    packages/harness/scripts/smoke-session-state.ts (5 steps: id resolution, ensure+meta preservation, concurrent isolation+cleanup, GC selective removal, GC no-op on empty root)
  Files modified:
    packages/harness-core/src/paths/index.ts — added sessionsDir, sessionStateDir, sanitizeSessionId; removed dead projectStatePath + stateRoot (no remaining callers post-cutover)
    packages/harness-core/src/status-line/writer.ts — statusJsonPath/writeStatusJson now require sessionId; dropped writeStatusJsonForSlug (slug-keyed variant is dead with the per-session move); defaultStatusJson param renamed to `sessionAlive` (the `daemon_alive` JSON key kept on the wire so format.ts's "daemon:down" placeholder rendering doesn't churn)
    packages/harness-core/src/status-line/reader.ts — readStatusForCLI(repoRoot, sessionId | null); placeholder when sessionId is null/empty/missing/malformed
    packages/harness-core/src/status-line/index.ts — exports updated; module docstring rewritten to reference PLUGIN_ARCHITECTURE §7
    packages/harness-core/src/init/init.ts — dropped Phase 5c baseline status.json write + post-Phase-6 attention_count patch (status.json is now per-session and seeded by SessionStart, not by init); dropped writeStatusJsonForSlug + defaultStatusJson imports
    packages/harness-core/src/doctor/index.ts — removed dead checkDaemonStatus + ageHintFromIso + pidLabel helpers (daemon is dormant; per-session status is created on every SessionStart so absence isn't a doctor signal); dropped projectStatePath import
    packages/harness/src/cli/hook.ts — SessionStart hook resolves session id, calls ensureSessionDir + writes default status.json, runs gcStaleSessions, then patches status with current decisions/invariants/attention counts. New `harness hook session-end` subcommand: reads payload session_id, calls cleanupSession (best-effort; stale dirs GC'd at next SessionStart anyway). Telemetry sessionId now comes from resolved id (post-fallback) instead of raw payload.
    packages/harness/src/cli/index.ts — `harness status-line` accepts `--session-id <id>` flag and falls back to reading Claude Code's status-line stdin payload (`{session_id, ...}`) with a 250 ms timeout. No stdin + no flag → null sessionId → placeholder.
    packages/harness-core/templates/.claude/settings.json — registers SessionEnd hook alongside SessionStart.
    packages/harness/scripts/smoke-status-line.ts — full rewrite for per-session sig: 6 steps (placeholder paths, two-session isolation, format priority cases).
    packages/harness/package.json — adds `smoke:session-state` script entry.
  Concurrency posture: per-session dirs are owned by one process — no lock per spec §7. The flock module from step 3 still wraps every global-state write tool (DEC capture, archive, drop-task). gcStaleSessions never touches a dir whose pid is alive, regardless of mtime.
  Notable design choice: the SessionStart hook patches per-session status.json **after** buildSessionStartContext computes decisions/invariants/pendingDrafts, so the status line reflects this session's real scope (not the default zeros). One extra write but it sets ctx_tokens_budget=4000 and the badge counts immediately.
  Step 3c (invalidation events + chokidar watcher) and step 4 (plugin scaffold) remain.

## Phase 6 — Initial ingestion sweep [DONE 2026-05-04T18:30]
Subagent attempts: 0 (inline)
Compile: PASS (workspace-wide tsc -b clean); smokes: smoke-init OK, smoke-session-start OK (8/8), new smoke-ingestion-baseline PASS (4/4 — DEC drafts + canonical-map + voice.md, baseline audit yaml, onboarding fires when 0 decisions/0 invariants, onboarding suppressed once first DEC accepted).
Notes:
  - New `init/ingest-docs.ts` (Phase 6.1 + 6.3): `discoverDocs(repoRoot)` walks docs/, .planning/, planning/, decisions/, adr/, architecture/, top-level AGENTS.md/README.md/CLAUDE.md and any loose top-level *.md. `runDocsIngestion({repoRoot, mockClassify?})` sorts candidates by byte-count, caps at 20, and dispatches one Haiku call per doc with concurrency 4 (Promise.allSettled-style worker pool). Classification schema: `{kind: decision|domain-rule|voice-guidelines|api-docs|other, proposedTitle, proposedRationale, topicSlug}`. `decision`/`domain-rule` → DEC draft in `_inbox/` with status `draft-from-init-docs` + sourceFile/proposedTitle/proposedRationale frontmatter. `voice-guidelines` → rewrites `brand/voice.md` only when the placeholder marker is still in place (status flipped to `current`). All non-empty topicSlugs get an entry appended under a "Phase 6 — adoption ingestion" header in `canonical-map/topics.yaml` (existing slugs deduped). DEC ids allocated through the canonical `allocateDecisionId` so they never collide with mapper-extracted drafts.
  - New `init/baseline-audit.ts` (Phase 6.4): `runBaselineAudit({repoRoot, projectGlobs, languages, onSensorProgress?})` lists tracked + untracked source files via `git ls-files --cached --recurse-submodules` + `--others --exclude-standard`, drops paths under skip dirs, filters to `.ts/.tsx/.js/.jsx/.py/.rb/.go/.rs/.sql`, and synthesizes a `DiffEntry[]` with status:added + afterContent loaded (1 MB per-file cap). Loads sensors.yaml via existing `loadSensorRegistry` (template fallback when `.harness/config/sensors.yaml` absent). Runs Layer A `runStubCatalog` + Layer D `runRouteHandlerNonEmpty` + `runDtoNoFakeFields`; every other registered sensor (attestation-cross-check / generator-drift / decision-assertions / invariant-suite / reviewer-subagent / e2e / uat / frontmatter-freshness / local-dirty-overlap) is recorded as `unsupported: true` so the audit yaml is transparent about what didn't run. Output written to `.harness/baseline/sensor-audit-<ISO>.yaml` with `{run_at, sensors[], total_findings, files_scanned}`. Public helper `findLatestBaselineAudit(repoRoot)` exposed for the SessionStart consumer.
  - `init/init.ts` Phase 6 wiring: new `runPhaseSix()` runs after Phase 5c daemon-autostart and before `printCompletionSummary`. Streams per-group ingestion rows (`docs/  ✓  3 DEC drafts proposed`) and first-three sensor rows + `+ N more…` overflow exactly per spec. Skipped when `args.skipIngestion === true || mode === "auto"` so smokes / scripted adoption don't burn Haiku tokens. `RunInitArgs` gains `skipIngestion?`. `InitResult` gains `ingestion: IngestionResult | null` and `baseline_audit: BaselineAuditResult | null`. `printCompletionSummary` renders a "Project brain populated from existing codebase" block with rows `DEC drafts        N proposed (run harness attention to review)` / `Canonical map     N topics seeded` / `Baseline debt     N existing sensor findings (run harness attention)` (each row omitted when its underlying count is zero). Early-return path for `proceedChoice === "b"` updated with `ingestion: null, baseline_audit: null`.
  - `session-start/build.ts` Phase 6.6 onboarding: new section `first_session_onboarding` rendered ONLY when `counts.decisions === 0 && counts.invariants === 0` AND a `.harness/baseline/sensor-audit-*.yaml` exists. The injected block reads the latest audit + sensors.yaml + .harness/config.yaml slug + minutes-since runAt, and prints `⬡ Harness active — <slug>` + adoption age + first-3 sensors + "+ N more" + baseline debt count + DEC drafts pending count + `/direction <your instruction>` tip. Section is pushed FIRST in `orderedSections` so it renders at the top of additionalContext, and LAST in `dropPriority` so it survives truncation. Once the operator accepts a DEC, `counts.decisions > 0` and the section is skipped — verified by the smoke's Step 4.
  - Public barrel: `init/index.ts` adds `defaultBaselineLanguages`, `findLatestBaselineAudit`, `runBaselineAudit`, `discoverDocs`, `runDocsIngestion` + the four result types.
  - New smoke `harness/scripts/smoke-ingestion-baseline.ts` (4 steps): seeds a temp git repo with placeholder voice.md + canonical-map seed + 4 docs (decisions/tone/api/AGENTS), runs ingestion with a mock classifier, asserts DEC draft frontmatter + canonical-map dedup + voice rewrite; runs baseline audit on a TS source file with a known stub pattern + asserts audit yaml; builds session-start + asserts onboarding section appears; writes a fake accepted DEC + asserts onboarding disappears.
  - Files added: packages/harness-core/src/init/{ingest-docs,baseline-audit}.ts; harness/scripts/smoke-ingestion-baseline.ts. Files modified: packages/harness-core/src/init/{init,index}.ts; packages/harness-core/src/session-start/build.ts; harness/package.json (smoke script entry).
