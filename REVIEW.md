# Cairn Architecture Review

## 1. MCP surface size + reduction
**Title**: 40 tools is severe context bloat; collapse by lifecycle phase.
**Evidence**: `packages/cairn-core/src/mcp/tools/index.ts` exposes 40 tools, including 15 `cairn_init_phase_*` tools. At ~150 chars per schema, that's 6,000+ chars of permanent context overhead per LLM turn.
**Recommendation**:
1. Collapse the 15 `cairn_init_phase_*` tools into a single `cairn_init_run({ phase: "..." })` tool.
2. Merge `cairn_decisions_in_scope` and `cairn_invariants_in_scope` into `cairn_in_scope({ types: ["decision", "invariant"] })`.
3. Combine `cairn_propose_decision` with `cairn_record_decision` by introducing a `target: "inbox" | "ledger"` flag.
**Effort**: Medium
**Risk**: Medium (LLM might hallucinate enum values if descriptions are stripped too aggressively)
**Confidence**: High

## 2. Context-filling waste
**Title**: Unloading init tools post-adoption saves permanent session weight.
**Evidence**: `mcp/tools/index.ts` statically exposes `initPhaseTools` even after adoption finishes, burning token window on dead code.
**Recommendation**: The MCP server should dynamically omit the 15 init tools from the registry if `.cairn/config.yaml` exists and `init-state.json` does not.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 3. Adoption pipeline shape
**Title**: 13 phases create unnecessary state I/O thrash.
**Evidence**: `packages/cairn-core/src/init/phases/*.ts`.
**Recommendation**:
1. Combine 1+2 (Detect + Walker). They sequentially scan the repo; combining them halves filesystem traversal.
2. Combine 3+3b (Mapper + Seed). They are sequential, always paired, and share mapper output state.
3. Collapse `6-docs-ingest` from four stages to two (file filter + LLM extraction).
**Effort**: Medium
**Risk**: Low
**Confidence**: Medium

## 4. Daily flow
**Title**: Reviewer subagent overhead on every multi-chunk task.
**Evidence**: `agents/reviewer.md` runs "AFTER all implementation subagents have completed" for every multi-chunk task regardless of complexity.
**Recommendation**: Make the reviewer opt-in based on a `needs_review: true` flag in `spec.tightened.md`, or trigger only if the dispatcher flags the diff as load-bearing. This saves one expensive LLM dispatch and its token context per trivial task.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 5. Hooks
**Title**: Write/Edit trigger sequential hooks (write-guard then sot-align).
**Evidence**: `packages/cairn-core/src/hooks/hooks.json` maps `PostToolUse(Write|Edit)` to both `cairn hook write-guard` and `cairn hook sot-align`.
**Recommendation**: Merge them into a single `cairn hook post-write` entrypoint. This saves ~300ms of Node/CLI boot overhead per file write.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 6. Sensors
**Title**: Decision assertions are over-engineered, relying on brittle regex.
**Evidence**: `sensors/decisions.ts` implements 10 assertion kinds via regex (e.g. `query_must_filter_by`, `service_method_must_call`).
**Recommendation**: Deprecate regex-based AST assertions entirely. They are fundamentally brittle against formatting and language paradigms. Rely on the LLM reviewer subagent for behavioral checks. Rename layers to A, B, C (instead of A, B, D + C drain).
**Effort**: Medium
**Risk**: Low
**Confidence**: High

## 7. GC sweep
**Title**: `completion-integrity` pass is unbounded and scales with repo age.
**Evidence**: `gc/completion-integrity.ts` validates all done-tasks historically.
**Recommendation**: Cap the integrity check to tasks modified in the last 30 days or cache successful verifications.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 8. Ground state writers
**Title**: `ground/` lacks boundary clarity between schemas, I/O, and compute.
**Evidence**: 18 files in `src/ground/`, mixing Zod schemas, File I/O, and heavy computation (e.g. `scope-index.ts` regex scans).
**Recommendation**: Refactor into `ground/schema/` (Zod), `ground/io/` (read/write), and `ground/compute/` (rescans, rebuilds) to enforce a clear data-access layer.
**Effort**: Medium
**Risk**: Medium (import path refactoring)
**Confidence**: High

## 9. Lock + concurrency
**Title**: `kill(pid, 0)` stale-lock check is cross-platform unreliable.
**Evidence**: `lock.ts` and `session/id.ts` both use `process.kill(pid, 0)` to check process liveness for stale lock and session GC.
**Recommendation**: Windows PID recycling makes `kill -0` highly unreliable. Add a lock timeout (e.g., 5 minutes) and a maximum session age (currently hardcoded to 24h in `defer.ts` and `session/id.ts`) as fallback mechanisms.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 10. Claude subprocess wrapper
**Title**: Subprocess overhead on Haiku batching.
**Evidence**: `claude/runner.ts` forks `claude` CLI for every call.
**Recommendation**: For Haiku batching (Phases 6/7), the Node subprocess boot time dominates. Implement concurrency throttling to prevent spawning 20+ Claude CLI instances simultaneously, which causes memory pressure and OS thread exhaustion.
**Effort**: Medium
**Risk**: Low
**Confidence**: Medium

## 11. Browser triage GUI
**Title**: Triage UI binds to 127.0.0.1 with zero auth.
**Evidence**: `attention/serve/index.ts` binds HTTP server to 127.0.0.1 without a token.
**Recommendation**: Any local script/malware on the operator's machine can hit `/api/*` and maliciously mutate `.cairn` state. Inject a one-time bearer token in the URL (`?token=...`) and validate it in `api.ts`.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 12. Lens extension
**Title**: Lens bundles the heavy `cairn-core`.
**Evidence**: `cairn-lens/package.json` depends on `@isaacriehm/cairn-core`. The CLI bundle size alone is **2.7MB**.
**Recommendation**: Extract a `cairn-state` lightweight package containing only Zod schemas and read-only I/O logic. Lens doesn't need `simple-git`, `chalk`, or `mcp-sdk` just to render UI.
**Effort**: Large
**Risk**: Medium
**Confidence**: High

## 13. CLI surface
**Title**: CLI subcommand sprawl.
**Evidence**: `cairn/src/cli/index.ts` has 15 top-level subcommands.
**Recommendation**:
1. Hide `hook` (make it a hidden subcommand or separate bin).
2. Flatten `fix` and `attention` into standard flags or top-level commands to maintain a coherent UX.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 14. Build + release
**Title**: Redundant dependency definitions and custom version sync script.
**Evidence**: `simple-git` is defined identically in both `packages/cairn/package.json` and `packages/cairn-core/package.json`. Furthermore, `scripts/sync-version.mjs` explicitly mutates 6 different JSON files across the monorepo instead of utilizing `workspace:*` capabilities at publish time.
**Recommendation**: Remove `simple-git` from `cairn` as it re-exports `cairn-core`. Use standard monorepo tooling like `changesets` for publishing rather than custom string manipulation scripts.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 15. CI gate vs. local gate
**Title**: Severe drift between CI and local test gates.
**Evidence**: `.github/workflows/ci.yml` runs 27 smokes (including `plugin-bundle`, `init-phases-all`, `init-mcp-tools`), but the local `pnpm smokes` command only runs 21. Adopter CI templates (`cairn-check.yml`) completely skip sensor execution.
**Recommendation**:
1. Sync `pnpm smokes` to execute the exact same bash loop as `ci.yml`.
2. Update the `cairn-check.yml` template to run `cairn sensor-run --staged` to actually enforce rules in adopting projects.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 16. Multi-dev enforcement
**Title**: Bypass detection log accumulation scales infinitely.
**Evidence**: `hooks/bypass-detection.ts` diffs against `.cairn/.attested-commits` which only ever appends data (via `cairn hook post-commit`).
**Recommendation**: Create a GC pass that trims `.attested-commits` to the last 100 entries.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 17. Templates shipped to adopters
**Title**: Test fixture leakage in templates.
**Evidence**: `templates/.cairn/sessions/<test-ids>/bypass-warned` exists in the template directory and is erroneously shipped to all adopting projects.
**Recommendation**: Add a `.npmignore` rule or an esbuild exclusion in `scripts/build-bundle.mjs` to strip `sessions/` fixtures from the distribution tree.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 18. Documentation hygiene
**Title**: Obsolete references to passes and phase gaps.
**Evidence**: `FILESYSTEM_LAYOUT.md` is stale, and there are gaps in phase numbering (7, 9, 11) in `init/phases/*.ts`.
**Recommendation**: Renumber phases to be contiguous. Fix the "5 passes" to "8 passes" in the README/CLAUDE.md. Update `lock.ts` docs to remove `flock` references.
**Effort**: Small
**Risk**: Low
**Confidence**: High

## 19. Prior art comparison
- **OpenAI's "harness lesson"**: Adopted. Core session context loading mechanism.
- **Aider's repo map**: Reinvented. Cairn's Sonnet mapper is expensive and slow compared to Aider's local tree-sitter AST parsing.
- **Cursor's `.cursor/rules/`**: Adopted/Specialized. Cairn uses granular file-per-decision rules instead of folder-scoped.
- **Continue's context providers**: Adopted. MCP server acts as the provider.
- **GitHub Copilot Workspace's spec format**: Adopted. `spec.tightened.md` closely mirrors this.
- **Devin / SWE-agent**: Invented. The session-bound ground state explicitly built to *prevent* drift across multiple distinct agent sessions is unique and novel.

## 20. Architectural inconsistencies
**Title**: Layer naming scheme is A, B, D, and C is a drain operation.
**Evidence**: `sot-align` uses Layer A/B/D for sensors, but Layer C for a SessionStart drain operation.
**Recommendation**: Rename the drain operation to a lifecycle phase instead of a sensor layer to avoid confusing categorization.

## 21. Missing pieces
**Title**: Missing token cache for Sonnet mapper and hardcoded 24h defer window.
**Evidence**: `claude/cache.ts` strictly only caches Haiku calls. The `defer.ts` window is hardcoded to `DEFAULT_DEFER_HOURS = 24`.
**Recommendation**: If the mapper runs repeatedly on the same module slices, caching Sonnet could save massive token costs. Additionally, the defer window needs to be configurable in `config.yaml` to suit different team velocities.

## 22. Code Optimization Audit
**Title**: Multi-domain performance audit identifying severe UI and API bottlenecks.
**Evidence**: Full report in `OPTIMIZATION.md`.
**Findings Summary**:
- **UI Thrashing**: `app.js` re-renders the entire DOM tree via `innerHTML` on every keystroke.
- **Async Inefficiency**: Sequential `await` in loops in `diff.ts` and `apply.ts`.
- **Resource Security**: Unbounded memory buffers and missing timeouts in `api.ts`.
- **Sync I/O**: Widespread use of `readFileSync` in async API handlers.

## 23. Top 10 ranked by impact-per-effort
1. **Fix Triage UI `innerHTML` re-parsing** (Impact: High, Effort: Small) - Eliminates severe input lag in browser triage.
2. **Auth token + Body limits for Attention API** (Impact: High, Effort: Small) - Fixes CSRF and OOM vulnerabilities in the local server.
3. **Parallelize Git Show in sensors** (Impact: High, Effort: Small) - Significantly speeds up Layer B/D sensor sweeps.
4. **Combine Write/Edit hooks** (Impact: High, Effort: Small) - Saves 300ms Node boot overhead on every LLM edit.
5. **Omit init tools post-adoption** (Impact: High, Effort: Small) - Reclaims ~2000 chars of MCP context per turn forever.
6. **Make Reviewer subagent opt-in** (Impact: High, Effort: Small) - Reduces turn latency and token burn on trivial tasks.
7. **Extract `cairn-state` for Lens** (Impact: High, Effort: Large) - Removes 2.7MB CLI bundle and massive dependencies from the VS Code extension runtime.
8. **Sync CI and local smokes** (Impact: Medium, Effort: Small) - Fixes severe drift where 6 load-bearing smokes are skipped locally.
9. **Add GC for `.attested-commits`** (Impact: Medium, Effort: Small) - Prevents unbounded disk growth.
10. **Collapse MCP Init Tools** (Impact: Medium, Effort: Medium) - Dramatically simplifies the adoption skill context window.
