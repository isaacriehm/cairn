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
