---
type: audit
status: complete
generated: 2026-05-03
---

# Harness Build Audit — Spec vs. Code

Current compile status: **CLEAN** (both `packages/harness-core` and `harness` compile with zero errors as of this audit).

## What exists (compiles clean)

| Module | Package | Status |
|--------|---------|--------|
| Ground state I/O (ledgers, manifest, walk, schemas) | harness-core | ✓ complete |
| MCP server + 19 tools | harness-core | ✓ compiles — 4 to remove from surface (Task 1) |
| SessionStart hook (sections 2-6) | harness-core | ✓ compiles — Section 0 missing (Task 4) |
| Decision capture | harness-core | ✓ complete |
| GC (5 passes) | harness-core | ✓ compiles — 2 passes missing (Tasks 9, 10) |
| Sensors (Layer A stub-catalog, attestation, decisions) | harness-core | ✓ complete |
| Init (detect, mapper, seed, prompts) | harness-core | ✓ compiles — 2 gaps (Tasks 7, 8) |
| Mirror (clone, sync, push, dirty-overlap) | harness-core | ✓ complete |
| Orchestrator / runner | harness-runtime | ✓ complete |
| Reviewer subagent | harness-runtime | ✓ complete |
| UAT pipeline | harness-runtime | ✓ complete |
| Backprop | harness-runtime | ✓ complete |
| CLI entry (harness package) | harness | ✓ compiles — missing status-line cmd |
| Hook CLI (session-start only) | harness | ✓ — read-enrich and write-guard missing |

## Gaps to close (ordered by dependency)

| # | Gap | Task | Dependency |
|---|-----|------|------------|
| 1 | Remove 4 banned tools from MCP surface + clean SessionStart tool reference | Task 1 | None |
| 2 | Status line module (writer/reader/format) + CLI subcommand | Task 2 | None |
| 3 | Context module: handoff builder + spec delta | Task 3 | None |
| 4 | Session-start Section 0 injection (run handoff) | Task 4 | Task 3 |
| 5 | Session-start brand + positioning injection | Task 4b | Tasks 4, 8 (read-time only — runs cleanly without 8 if files absent) |
| 6 | Read enricher PostToolUse hook | Task 5 | None |
| 7 | Write guardian PostToolUse hook + sensors.yaml extension | Task 6 | Task 5 (copy-scanner pattern) |
| 8 | Settings.json template includes PostToolUse hooks | Task 7 | Tasks 5, 6 |
| 9 | Brand/product/capabilities stubs as templates | Task 8 | None |
| 10 | Scope index: type, init seed, hook integration, GC pass stub | Task 9 | Tasks 3, 5, 6, 8 |
| 11 | GC completion integrity pass | Task 10 | None |
| 12 | GC citation integrity pass | Task 11 | Tasks 5, 10 |
| 13 | harness_append_run_note MCP tool + path-allowlist update | Task 12 | Task 3 |
| 14 | Smoke tests for new modules | Task 13 | Tasks 2, 3, 5, 9 |

## What is NOT in scope for this build session

- `harness-frontend-cli` package (harness-frontend-stub serves as the default for now)
- Voice module updates (in wrong layer per ARCHITECTURE.md §6 — deferred)
- Discord frontend adapter updates (separate adapter concern)
- Full E2E test suite (smoke tests only)
