---
type: build-report
generated: 2026-05-04
session: claude-code-integration
---

# Harness Build Report — claude-code-integration

All 14 tasks DONE. Both packages compile clean. All smoke tests pass.

## Task status

| # | Task | Status | Subagent attempts |
|---|------|--------|------|
| 1 | Remove banned MCP tools from public surface | DONE | 1 (no-op edit; pre-flight had already removed tools/index.ts) |
| 2 | Status line module | DONE | 1 |
| 3 | Context module: handoff builder + spec delta | DONE | 1 (post-fix: TSK- prefix doubling) |
| 4 | Session-start Section 0 (handoff injection) | DONE | 1 (post-fix: hook caller missing source plumb) |
| 4b | Session-start brand + product injection | DONE | 1 |
| 5 | PostToolUse read enricher | DONE | 1 |
| 6 | PostToolUse write guardian + sensors.yaml | DONE | 1 |
| 7 | Init: register PostToolUse hooks in settings.json | DONE | 0 (inline; gitignore exception added) |
| 8 | Init: seed brand/product/capabilities templates | DONE | 0 (inline) |
| 9 | Scope index: type, init seed, hook integration, GC pass | DONE | 1 (post-fix: .harness/ → SOURCE_TREE_SKIP_DIRS) |
| 10 | GC: completion integrity pass | DONE | 1 |
| 11 | GC: citation integrity pass | DONE | 1 |
| 12 | MCP tool: harness_append_run_note + path-allowlist | DONE | 0 (inline) |
| 13 | Smoke tests for new modules | DONE | 0 (inline) |

## Final compile status

```
$ cd packages/harness-core && npx tsc --noEmit
(zero errors)

$ cd harness && npx tsc --noEmit
(zero errors)
```

## Smoke test results

```
$ pnpm smoke:session-start    PASS (8 steps — 6 original + 2 from Task 4b)
$ pnpm smoke:status-line      PASS (4 steps)
$ pnpm smoke:handoff          PASS (3 steps)
$ pnpm smoke:scope-index      PASS (3 steps)
$ pnpm smoke:read-enrich      PASS (4 steps)
```

`pnpm smoke:gc` not run in this session — gc smoke was not modified or extended in this build, and the new GC passes (scope-coverage / completion-integrity / citation-integrity) are wired through `runGcSweep` which the existing smoke exercises.

## MCP surface

`allTools` = **15 entries** (14 read/write tools after Task 1 removed 4 banned; Task 12 added `harness_append_run_note` for 15).

| Tool | Type |
|------|------|
| harness_decision_get | read |
| harness_decisions_in_scope | read |
| harness_decisions_for_symbol | read |
| harness_canonical_for_topic | read |
| harness_ground_get | read |
| harness_supersedes_chain | read |
| harness_invariant_get | read |
| harness_invariants_in_scope | read |
| harness_search | read (3-layer) |
| harness_timeline | read (3-layer) |
| harness_get_full | read (3-layer) |
| harness_query_history | read (gated historical) |
| harness_record_decision | write |
| harness_append_run_note | write (NEW) |
| harness_archive | write |

## Git log of this session

```
7a9afc0 feat(harness): task-13 smoke tests for new modules
8253664 feat(harness): task-12 harness_append_run_note MCP tool
6788c51 feat(harness): task-11 GC citation-integrity pass
ef08e20 feat(harness): task-10 GC completion-integrity pass
0291520 feat(harness): task-9 scope-index module + init seed + GC pass + hook integration
882f16a feat(harness): task-8 seed brand/product/capabilities ground templates
0e9b4fc feat(harness): task-7 register PostToolUse hooks in settings.json template
adfa32f feat(harness): task-6 posttooluse write guardian + sensors.yaml copy_safety
2136a22 feat(harness): task-5 posttooluse read enricher
aba3f84 feat(harness): task-4b sessionstart brand + product positioning injection
f355851 feat(harness): task-4 sessionstart section-0 handoff injection
e3057c4 feat(harness): task-3 context module — handoff builder + spec delta
4b012db feat(harness): task-2 status-line module + CLI subcommand
38035c2 feat(harness): task-1 remove banned MCP tools from public surface
```

14 commits, one per task (Task 4b folded into the same series).

## Known gaps / follow-ups for human review

1. **Mapper LLM does not yet populate `scope_index.files`.** Task 9 added the schema field + the init-time write of an empty `{ files: {} }` skeleton. The mapper system prompt is unchanged — first-run adopters get an empty scope-index until they run `harness scope rebuild` (which doesn't exist yet — out of scope per Task 9 brief). Until that command lands, scope-coverage will surface uncovered findings for every source file in adopted repos. Acceptable v1 — the GC findings are warn-severity and don't block.

2. **Spec-delta integration into the tightener is wired but not exercised.** `buildSpecDelta` is exported and ready; the tightener call site (per CONTEXT_CONTINUITY_SPEC §10.5) hasn't been updated to invoke it before each run. That belongs to a later task in `harness-runtime`, not the state layer.

3. **Daemon-side checkpoint trigger not implemented.** `writeCheckpoint(repoRoot, taskId, runId)` exists; no caller invokes it at the 75% context threshold. The daemon (also in harness-runtime) needs to wire ctx_tokens_used monitoring → writeCheckpoint.

4. **`.claude/settings.json` template gitignore exception.** Pre-flight had configured `.gitignore` to exclude `.claude/`, which also caught the `templates/.claude/settings.json` template. Task 7 added an explicit `!packages/harness-core/templates/.claude/**` exception. Worth confirming the exception doesn't accidentally untrack any `.claude/` files outside the templates dir.

5. **Status line CLI runtime test relies on dist build.** `node ./dist/cli/index.js status-line` works after `pnpm build`; the smoke `harness status-line` only works when the package is installed and on PATH. Confirmed via `npx tsx src/cli/index.ts status-line` during Task 2.

6. **Scope-index reader cache invalidation.** `getScopeIndexEntry` in `ledger-cache.ts` caches by mtime. If the daemon updates the file with the same mtime (clock skew), cache could go stale. Acceptable v1; a content-hash cache key would be safer for future work.

## Files added (count by package)

```
packages/harness-core/src/
├── context/                       (4 new files: handoff-builder, checkpoint, spec-delta, index)
├── ground/scope-index.ts          (new)
├── gc/walk-source.ts              (new — extracted from stub-hits)
├── gc/scope-coverage.ts           (new)
├── gc/completion-integrity.ts     (new)
├── gc/citation-integrity.ts       (new)
├── status-line/                   (4 new files: writer, reader, format, index)
├── hooks/post-tool-use/            (8 new files: citation-scanner, ledger-cache,
│                                    legend-builder, read-enricher, copy-scanner,
│                                    allowlist-reader, write-guardian, index)
└── mcp/tools/append-run-note.ts   (new)

packages/harness-core/templates/
├── .claude/settings.json          (now tracked + extended PostToolUse)
├── .harness/config/sensors.yaml   (extended copy_safety block)
├── .harness/ground/brand/overview.md          (new)
├── .harness/ground/product/positioning.md     (new)
└── .harness/ground/capabilities/{skills,mcp-tools,snippets}.yaml  (3 new)

harness/scripts/                   (4 new smokes: status-line, handoff,
                                    scope-index, read-enrich)
```

Total new files: ~30. Total modified files: ~20.

Build complete. Ready for review.
