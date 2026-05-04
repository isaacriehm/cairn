---
type: audit
status: draft
audience: dual
generated: 2026-05-04
audited-commit: 9fe2b95
---

# State + doc surface audit — Claude Code integration prep

## Summary

The state layer is structurally clean: 18 MCP tools + 5 GC passes + 5 sensor classes wired through a coherent ground/ + sensors/ + decision-capture/ stack, all green under `pnpm -r build` + 23 smokes. Two findings dominate. **(1)** `harness_query_history` — the load-bearing tool the Claude Code integration brief assumes "exists" for two-zone enforcement — returns a `NOT_IMPLEMENTED` envelope and awaits Phase 5+ Tier-1 wiring. **(2)** Doc surface is materially out of sync with code: ARCHITECTURE.md §3.1 lists pre-9fe2b95 dirs (no profiles/ mirror/ voice/ prompt.ts/ inbox.ts/ frontend-types.ts), MCP_SURFACE.md says 16 tools (reality 18, missing `harness_ask_operator`), FILESYSTEM_LAYOUT.md §10 + PRIMER §4.4 still prescribe the PreToolUse hook the operator just rejected. Subsystem cohesion is good; redundancy is local (catalog.ts vs stub-catalog.ts naming, two glob walkers, duplicate DEC-id allocators); no bloated files. Naming-drift to old L01–L50 / Phase-NN / INTEGRATION_PLAN §16.x scaffolding survives in code comments and commit-message templates.

## Per-subsystem findings

### ground/ (10 files)

- `glob.ts` line 7 self-flags as a duplicate of `mirror/dirty-overlap.ts` `compileGlob`. Two homes for the same matcher. Pick one.
- `ledgers.ts` lines 122-123 leak `parseYaml, resolve` re-exports — only useful to tests; remove or move to a test util.
- `buildDecisionsLedger` filters to `status === "accepted"` AND `!superseded_by`, but MCP `harness_decisions_in_scope` accepts `status: ["accepted", "superseded"]` per its schema. Ledger consumer wanting full history doesn't get it from the writer's view.
- `quality-grades.ts` `recent_run_count = Math.ceil(acc.total / 10)` is a sensor-count-divided-by-10 proxy presented as run count. Misleading — either compute real runs or drop the field.
- `schemas.ts` `ManifestEntry.related_invariants` is read by no producer; classify() in manifest.ts doesn't populate it. Either wire `decision-frontmatter → manifest` lift or drop the field.
- `walkCanonical` SKIP_DIRS includes `.archive` — correct historical separation at walker level; reinforces the rejected-hook decision (filesystem walkers already exclude historical zone, so PreToolUse adds nothing the agent can't already not-see).
- `DriftEvent.kind` enum includes `"manifest_hash_changed"` — no producer in the codebase. Dead enum case.

### decision-capture/ (11 files)

- File count maps cleanly to surface: extractor + refiner = two Tier-1 calls, each with its own prompt + JSON-schema + types module. Defensible split.
- `writer.ts` holds BOTH the draft writer (`writeDecisionDraft`/`acceptDraft`/`rejectDraft`) AND the refinement-lift writer (`liftCandidatesToAssertions`/`LiftVerdict`). Mild cohesion concern; both touch the same decision file so single-file is OK, but a `writer-draft.ts` + `writer-refinement.ts` split would clarify.
- `writer.ts` line 13 references "L13.2 monotonic principle" — that lock list was authored under the superseded RESUME framing. Naming-drift to nonexistent canonical source.
- `id.ts` allocates next DEC-NNNN by filename regex. `mcp/tools/record-decision.ts` allocates by parsed-frontmatter-id. Two implementations diverge if drafts have malformed frontmatter (`id.ts` counts them, `record-decision.ts` skips them). Pick one.
- Refinement dialog hardcodes a 1700-char DIALOG_PROMPT_CHAR_CAP for Discord. That cap belongs in `frontend-types.ts` or a discord-adapter constant, not in core.

### gc/ (11 files)

- `sweep.ts` imports `selectProfile` from `../profiles/index.js` and `Profile` type. Profiles is not listed in ARCHITECTURE §3.1 and not described anywhere in docs/.
- `canary.ts` synthetic-context shape (`agent_role, run_id, mirror_path, sha_pin, tightened_spec_body, acceptance_criteria, in_scope_decisions, in_scope_invariants, off_limits, scoped_sensors`) is the implicit per-run prompt-context contract. SessionStart spec should mirror these field names where applicable.
- Two walkers: `walkCanonical` (ground/walk.ts, canonical-zone only) and `walkSourceTree` (gc/stub-hits.ts, full source tree). Different scopes; consider a shared `walk(repoRoot, { mode: "canonical" | "source" })`.
- `frontmatter.ts` line 128 `void stringifyYaml; void rawBlock;` is dead-import suppression for a "future rewrite the whole block" mode. Either implement or drop.
- Commit-message templates throughout reference "L16/L17/L18 (PRIMER §12.2)" — those L-locks aren't defined in any current doc.

### sensors/ (10 files)

- `catalog.ts` (loader) and `stub-catalog.ts` (evaluator) — names suggest overlap. Rename loader → `loaders.ts` (it loads sensor registry too).
- `decisions.ts` covers all 11 `DecisionAssertion` kinds. AST + ORM evaluators are documented "v1 fallback" regex approximations.
- `structural.ts` `METHOD_ALLOWLIST` hardcodes Angular/NestJS lifecycle hooks (`ngOnInit`, `onModuleInit`, etc.) — minor project-bias inside a "project-agnostic" sensor.
- `runner.ts` ignoreGlobs hardcoded for `.harness/runs/active/**` + `.harness/inbox/processed/**`. Move to a sensor-config constant.
- `decisions.ts` `listMirrorFiles` uses `execSync('git ls-files')` while diff.ts uses `simple-git`. One choice.

### mcp/ (8 server files + 18 tools)

| Tool | Doc-match (MCP_SURFACE.md) | Redundant-with | Needed-for-SessionStart |
|------|---------------------------|----------------|-------------------------|
| `harness_decision_get` | yes | — | yes (per-decision fetch on demand) |
| `harness_decisions_in_scope` | yes | — | **yes (primary)** |
| `harness_decisions_for_symbol` | yes | partial overlap with decisions_in_scope + symbol-grep | no (run-time lookup) |
| `harness_invariant_get` | yes | — | yes (on demand) |
| `harness_invariants_in_scope` | yes | — | **yes (primary)** |
| `harness_canonical_for_topic` | yes | — | yes (topic registry list) |
| `harness_ground_get` | yes (overlaps `get_full` for some kinds) | partial overlap with `get_full` for `manifest`/`quality_grades` | yes (quality_grades for weakest-modules) |
| `harness_supersedes_chain` | yes | — | no (rare) |
| `harness_search` | yes (Phase 4 baseline naive substring) | — | no |
| `harness_timeline` | yes (Phase 4 baseline) | — | no |
| `harness_get_full` | yes | overlaps `ground_get` for some kinds; overlaps `decision_get` for `kind="decision"` | yes (current task spec.tightened.md) |
| `harness_query_history` | yes — but **NOT_IMPLEMENTED stub** | — | **load-bearing** (two-zone enforcement assumes this works) |
| `harness_append` | yes | — | no |
| `harness_record_decision` | yes (but `target: "accepted"` is callable from any agent — no auth) | — | no |
| `harness_record_run_event` | yes | — | no |
| `harness_drop_task` | yes | — | no |
| `harness_archive` | yes | — | no |
| `harness_ask_operator` | **NOT IN DOC** | — | no (run-time pause) |

Other mcp/ findings:
- `tools/ground-get.ts` line 87 uses `require("node:fs")` inside a function — CommonJS require in an ESM file. Style violation; switch to `import { readdirSync } from "node:fs"`.
- `tools/invariants-in-scope.ts` line 69 + `tools/search.ts` line 175 use `void parseYaml` / `void statSync` to suppress unused-import warnings — dead code, drop the imports.
- `tools/record-decision.ts` allows `target: "accepted"` from any agent caller. Doc says "operator-only override; not used by agents" but the server has no auth surface. Either remove the option from the input schema or gate it on a context flag (`ctx.fromOperator`).
- `tools/timeline.ts` scope filter is naive substring on `meta.scoped_module` — won't match path globs; doc claims it accepts globs.
- Telemetry writes `mcp-calls.jsonl` per run when `ctx.runId` is set, otherwise to `staleness/`. Sensible; no findings.
- Path-allowlist correctly denies historical-zone glob matches; `safeJoin` correctly rejects `..` escapes.

### init/ (11 files)

- File count is tight. Cohesion clean: detect (mechanical signatures) + walker (gitignore-aware repo summary) + mapper (Tier-2 LLM proposing globs) + seed (template copy + placeholder substitute) + workflow-block (round-trip slug block) + secrets (env file) + prompts (inquirer wrappers) + setup-runners (subprocess for whisper/ollama/uat).
- `mapper.ts` block-comment cites `docs/INTEGRATION_PLAN.md §16.2 line 471 + L37 + the rework brief §3.1` — INTEGRATION_PLAN is now banner-flagged superseded. Naming-drift to old framing.
- `init.ts` runs `setup:uat-{browsers,sql,docker}` scripts via `pnpm exec tsx ...scripts/setup-uat-*.ts`. Those scripts live under `packages/harness-core/scripts/` — but core's directory listing didn't surface them, suggests they're under a different path or yet-to-be-extracted. Verify the spawn path resolves.
- `init.ts` and `mirror/index.ts` both encode the `~/.local/harness/repos/<slug>/` path. One source.
- `init.ts` E2E setup branch makes core depend on UAT runtime concerns. Per ARCHITECTURE the UAT pipeline is a runtime-layer concern; this could move out of init.ts into a runtime hook, but operator-driven adoption flow makes the current placement defensible.
- `walker.ts` framework-signal lists are well-curated (ts/py/rb/go/rust). Good.

### templates/

- 4 config files: `workflow.md`, `sensors.yaml`, `stub-patterns.yaml`, `trust-policy.yaml`. Plus 2 ground seeds (`manifest.yaml` + `canonical-map/topics.yaml`), `templates/README.md`, `.archive/README.md`. Clean.
- `workflow.md` uses `<project_name>` placeholder that init/seed.ts substitutes. Verified no leftover `mypal` references in templates (ARCHITECTURE forbids).
- `workflow.md` body uses Handlebars-style `{{var}}` + `{{#each LIST}}{{this.field}}{{/each}}`; `prompt.ts` `renderTemplate` implements the matching subset. Good cohesion.
- `topics.yaml` ships **empty**. `harness_canonical_for_topic` returns `TOPIC_NOT_REGISTERED` until adopters populate. Init flow does not seed any topics. Decision needed: ship a baseline (e.g. `agents-md`, `architecture`, `decisions-readme` mapping to canonical paths) or defer.
- `manifest.yaml` ships empty `files: []`. Same pattern — daemon-populated.
- `sensors.yaml` line 71 `profile_hook: profile.generators` and line 111 `profile_hook: profile.e2e_command` both reference the undocumented `profiles/` package.
- `.archive/README.md` references "PreToolUse hook denies `Read | Grep | Glob`" — same drift as FILESYSTEM_LAYOUT §10.
- `trust-policy.yaml` lists 9 slash commands. Confirmed against `harness-frontend-discord` slash registration would be a separate audit; not in scope here.

### docs/

| File | Drift from code | Recommended action |
|------|-----------------|---------------------|
| `ARCHITECTURE.md` §3.1 | Lists `init, ground, mcp, gc, decision-capture, claude, tier0, tightener, stub-pattern, decision-assertion, provenance, types.ts, logger.ts`. Reality also has `profiles/, mirror/, voice/, prompt.ts, inbox.ts, frontend-types.ts`; `stub-pattern` + `decision-assertion` consolidated into `sensors/`; `provenance` folded into `ground/frontmatter.ts`. | Update §3.1 enumerations to match post-9fe2b95 layout. |
| `ARCHITECTURE.md` §3.3 | Lists `voice/` under `harness-frontend-discord`. Brief §1 says voice/ moved to core. | Move §3.3 voice line to §3.1 with rationale (uat/rejection consumes `transcribeUrl`). |
| `ARCHITECTURE.md` §6 | "Migration path single → multi-package" — historical, migration is done. | Mark as `status: completed` or move to `docs/_history/`. |
| `ARCHITECTURE.md` §7 | "Open questions" — answered post-9fe2b95 (mirror/voice/inbox locations now fixed). | Remove or move to `docs/_history/`. |
| `PRIMER.md` §4.4 | "Enforcement = PreToolUse hook on Read/Glob/Grep filters out historical paths." | Rewrite as "Enforcement = SessionStart instruction + `harness_query_history` MCP tool" — match RESUME §2 lock. |
| `PRIMER.md` §11 | Anti-pattern list does NOT include "PreToolUse for two-zone separation" — it should given the operator decision. | Add the entry. |
| `MCP_SURFACE.md` §"Tool catalog (16 tools)" | Reality 18 tools (`ask-operator` undocumented; doc enumerates 17, says 16). | Update count + add full `harness_ask_operator` section (input schema, returns, file paths, polling). |
| `MCP_SURFACE.md` §Implementation outline | Path tree shows `harness/src/mcp/...` — pre-package-split path. | Update to `packages/harness-core/src/mcp/...` |
| `MCP_SURFACE.md` §"harness_query_history" | Documents full Tier-1 summarization flow. | Reality is `NOT_IMPLEMENTED` envelope. Either implement (load-bearing for SessionStart context) or banner the section. |
| `FILESYSTEM_LAYOUT.md` §2.3 + §10 | Describes PreToolUse hook for canonical-only enforcement + the `.claude/settings.json` block. | Rewrite §2.3 + §10 to drop PreToolUse and add SessionStart-only path with `harness_query_history` as the explicit escape. |
| `FILESYSTEM_LAYOUT.md` §11 | "Init script — Detailed in INTEGRATION_PLAN.md Phase 16" | Update to `init/` package surface description; INTEGRATION_PLAN is superseded-banner. |
| `WORKFLOW_GUIDE.md` §0.1 | "Common types live in `harness/src/frontend/types.ts`. Each adapter is its own subdirectory: `harness/src/frontend/discord/`..." | Update to `packages/harness-core/src/frontend-types.ts` and `packages/harness-frontend-discord/src/`. |
| `WORKFLOW_GUIDE.md` §11 | Hardcoded `mypal:` example workflow.md block. Per S1 illustrative-only is fine; flag once for re-readers. | Add a "this is illustrative" comment at top of §11. |
| `INTEGRATION_PLAN.md` | Has superseded-banner already. | Move to `docs/_history/INTEGRATION_PLAN_v2.md` so it doesn't show up in default doc-search. |
| `QUESTIONS.md` M1 | Says `@isaac/harness`. Reality `@devplusllc/harness*` (4 packages). | Update or close-out (questions are mostly answered). |
| `QUESTIONS.md` overall | "Most architectural decisions are locked." Many are now answered. | Either mark `status: closed` or sweep into `docs/_history/`. |
| `CODEX_REVIEW_BRIEF.md`, `CODEX_REVIEW_BRIEF_REVIEW.md` | Not in `AGENTS.md` TOC. | Add to TOC or move to `docs/_review/`. |
| `UAT_PIPELINE.md` | Skim only per brief; runtime concern. | No action this audit. |

## Recommendations (ranked)

1. **Implement `harness_query_history` OR formally re-scope two-zone enforcement.** The brief §2 locks in "two-zone separation enforced via SessionStart instruction + the existing `harness_query_history` MCP tool." Reality: the tool is a `NOT_IMPLEMENTED` stub. Either build the Tier-1 summarizer (one new module + reuse `claude/runner` infra) before SessionStart ships, or commit to soft-only enforcement (canonical-only walkers + SessionStart instruction text) and remove archive-summary references from the spec.

2. **Bring ARCHITECTURE.md §3.1 + §3.3 + §3.5 up to post-9fe2b95 reality.** Add `profiles/, mirror/, voice/, prompt.ts, inbox.ts, frontend-types.ts` to harness-core; remove `voice/` from harness-frontend-discord listing; collapse `stub-pattern/` + `decision-assertion/` references into `sensors/`. Drop §6 "migration path" + §7 "open questions" or move to `docs/_history/`.

3. **Reconcile MCP_SURFACE.md to 18 tools.** Add full `harness_ask_operator` section (currently undocumented). Update implementation-outline path. Mark `harness_query_history` either NOT_IMPLEMENTED or implement it per recommendation 1.

4. **Strip PreToolUse references repo-wide.** Files: PRIMER §4.4, FILESYSTEM_LAYOUT §2.3 + §10, `.archive/README.md` "Reading from .archive/" section. Replace each with the SessionStart-instruction-only enforcement model. Add PreToolUse to PRIMER §11 anti-pattern list.

5. **Consolidate the two glob walkers and the two DEC-id allocators.** `ground/glob.ts` already documents the duplication with `mirror/dirty-overlap.ts`; pick one. `decision-capture/id.ts` and `mcp/tools/record-decision.ts` both allocate next-DEC-id with subtly different scan logic; pick one as canonical.

6. **Drop or implement dead-code stubs.** `gc/frontmatter.ts` line 128 `void stringifyYaml; void rawBlock;`, `mcp/tools/invariants-in-scope.ts` line 69 `void parseYaml`, `mcp/tools/search.ts` line 175 `void statSync`. None of these guard real behavior; remove the unused imports.

7. **Fix `mcp/tools/ground-get.ts` `require("node:fs")` to ESM import.** Standalone style fix.

8. **Decide whether `topics.yaml` ships seeded or empty.** Empty means every adopter starts with `TOPIC_NOT_REGISTERED` for everything. Even a 3-entry baseline (`agents-md`, `architecture`, `decisions-readme`) gives `harness_canonical_for_topic` something to return out of the box.

9. **Centralize the `~/.local/harness/repos/<slug>/` path.** Currently encoded in `init.ts` text + `mirror/paths.ts`. One source.

10. **Strip naming-drift to L01–L50 / Phase-NN / INTEGRATION_PLAN §16.x.** Code comments and commit-message templates throughout reference these. Either re-anchor to ARCHITECTURE locks (§3.1, §3.3, §4) or remove the citations.

## Open questions for operator

- **Q1 — `harness_query_history`: build before SessionStart, or scope it out?** Building is one Tier-1 prompt (`prompts/history_summarize.v1.md` already named in MCP_SURFACE) + a reuse of `claude/runner.ts`. Estimated 1-2 hours. Without it, two-zone enforcement is soft only — agents won't see archive content because the walkers exclude it, but they also can't query the summary. Brief assumes the tool exists.
- **Q2 — Will SessionStart inject the operator's full task?** Two flavors: (a) inject the LATEST `tasks/active/<id>/spec.tightened.md` whole; (b) inject only `decisions_in_scope` + invariants and let the agent read the spec on its own. (a) is fewer round-trips; (b) keeps the SessionStart payload tiny. Recommend (a) when there's exactly one active task, (b) when there's >1.
- **Q3 — Topics.yaml baseline vs empty?** See recommendation 8.
- **Q4 — `harness_record_decision target:"accepted"` auth?** Currently any caller can write canonical. Acceptable for v0 since the only caller is the operator's own claude session, but worth confirming.
- **Q5 — Naming-drift cleanup as part of this audit's recommendations, or a separate pass?** Affects ~20 code comments and ~5 docs.
- **Q6 — Smoke-suite for SessionStart?** End-to-end requires Claude Code installed + a real session. Recommend a unit-level smoke that builds the payload from a fixture `.harness/` and asserts the JSON shape, plus a manual verification step.
