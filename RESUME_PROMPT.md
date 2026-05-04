---
type: resume-prompt
status: claude-code-integration-audit
audience: ai-only
generated: 2026-05-04
purpose: Package split landed (commit 9fe2b95). Next phase shifts focus to **state + context layer integration with Claude Code** via MCP + SessionStart hook. Before any code lands, a fresh agent must re-review the entire state/doc management surface and produce two deliverables (§4). Do not start coding hooks before the audit is done and the operator approves direction.
---

# Resume Prompt — Claude Code integration + state/doc audit

You are picking up Cairn mid-arc. The four-package split (state + context layered model) is complete and clean. The next phase shifts focus to **getting harness-core integrated into Claude Code** — but the operator wants to step back first and audit the state/doc management surface before more code lands on top of it. Your job this session is the audit + a tight design memo, not implementation.

Read this end-to-end. Then read `docs/ARCHITECTURE.md` and `docs/PRIMER.md` (skim §11 anti-patterns). Then complete §3 + §4 below.

## 1. What's true at handoff

Last commits:

```
git log --oneline -3

9fe2b95 refactor: package split per docs/ARCHITECTURE.md (state + context layered model)
1713d3f refactor: skeleton package split (state + context layered model)
746c54a fix: per-Q walk stall + UX cleanups (§3.4)
```

Workspace layout (post-split, locked):

```
Cairn/
├── packages/
│   ├── harness-core/            ← state + context. The Cairn. Includes
│   │                              MCP server (18 tools), init mapper, ground
│   │                              writers, gc, decision-capture, sensors,
│   │                              tightener, claude wrapper, tier0,
│   │                              templates/, mirror, voice.
│   ├── harness-runtime/         ← orchestration consumer (FIFO, dispatch,
│   │                              reviewer, UAT, backprop, watchdog).
│   ├── harness-frontend-discord/ ← Discord adapter (bot + channels + slash).
│   └── harness-frontend-stub/   ← in-memory test adapter.
└── harness/                     ← umbrella + CLI bin (init/run/watch/
                                   task/install/mcp/gc/daemon).
```

Verification status:
- `pnpm -r build` — green across all 5 packages.
- `pnpm -F @isaacriehm/harness check:layout` — OK; sensor was rewritten for the new layout in 9fe2b95.
- 23 smokes pass: mirror, watch, mcp, tier0, tightener, sensors, reviewer, gc, backprop, decision-capture, decision-refinement, init, init-mapper, steering, visibility, ux-cleanups, quota-archive, cli-extras, discord, orchestrator, uat-rejection, uat-question, uat-runner.
- `smoke:uat` skipped (chromium hang, environmental, predates this work).

Departures from earlier RESUME §3 layout, locked in 9fe2b95 (do not re-debate):
- `orchestrator/prompt.ts` (workflow.md template loader) → harness-core.
- `mirror/` (full dir) → harness-core (init bootstrap needs `ensureMirror`).
- `voice/` (full dir) → harness-core (uat/rejection needs `transcribeUrl`; runtime can't depend on a frontend).
- `sensors/` (full dir) → harness-core (gc imports stub-catalog + decision-assertion evaluators; per ARCHITECTURE §3.1 those are state-layer).

These four moves are forced by the layer rule "core never imports from runtime/frontend." The corresponding deps (simple-git, smart-whisper) are now in `harness-core/package.json`.

## 2. The phase pivot — what we're doing next, and why

The operator stated:
1. **Focus on the state-management half first.** Drop runtime + frontend concerns until the state layer is solid through Claude Code.
2. **Integrate with Claude Code first.** The harness-core MCP + ground-state surface should be reachable from inside any `claude code` session in any project that runs `harness init`.
3. **Re-review state/doc management before building more.** The split clarified WHERE code lives but didn't audit WHAT the state surface actually is. Before we start wiring hooks + onboarding adopters, we need to look at the whole state surface end-to-end and confirm it's coherent.

Two binding decisions from this session:
- **PreToolUse hook = rejected.** Operator explicitly wary: buggy hook bricks the session, false positives block legit work, hard to debug, whole-session brittleness. The two-zone canonical/historical separation (PRIMER §4.4) gets enforced via SessionStart instruction + the existing `harness_query_history` MCP tool, not via tool-call interception. Do not propose PreToolUse again unless soft enforcement provably fails AND you bring a strong override + dry-run mode to the proposal.
- **Standalone hooks/MCP first; plugin format later.** `harness init` will write `.mcp.json` + `.claude/settings.json` directly into the adopting project. Claude Code plugin packaging is for later, when the hook + slash surface is stable.

Hooks ranked by priority (locked):
1. **SessionStart** — first to land. Inject curated state context (decisions in scope, §V invariants, current task, weakest module, pending drafts).
2. **UserPromptSubmit** — second; routes `/direction` text into decision-capture. Needs runtime threading.
3. **Stop** — third; potential backprop trigger on session end.
4. **PreToolUse** — rejected (see above).

## 3. The audit — re-review the state/doc surface

Read every file below and form a mental model. Then write the audit memo (§4.1).

### 3.1 Ground writers + schemas
- `packages/harness-core/src/ground/index.ts` — public surface barrel.
- `packages/harness-core/src/ground/schemas.ts` — DecisionFrontmatter, InvariantFrontmatter, QualityGrades, etc.
- `packages/harness-core/src/ground/paths.ts` — directory layout.
- `packages/harness-core/src/ground/manifest.ts` — manifest builder.
- `packages/harness-core/src/ground/ledgers.ts` — decisions + invariants ledger writers.
- `packages/harness-core/src/ground/quality-grades.ts` — per-module score writer.
- `packages/harness-core/src/ground/drift.ts` — drift event recorder.
- `packages/harness-core/src/ground/frontmatter.ts` — provenance parsing + freshness eval.
- `packages/harness-core/src/ground/walk.ts` — canonical-zone walker.
- `packages/harness-core/src/ground/glob.ts` — match helpers.

### 3.2 Decision capture
- `packages/harness-core/src/decision-capture/index.ts` — full surface.
- `packages/harness-core/src/decision-capture/extractor.ts` — Tier-1 LLM call.
- `packages/harness-core/src/decision-capture/refinement.ts` — strict-assertion proposer.
- `packages/harness-core/src/decision-capture/writer.ts` — accept/reject/draft.
- `packages/harness-core/src/decision-capture/capture.ts` — end-to-end flow.

### 3.3 Garbage collection
- `packages/harness-core/src/gc/index.ts` — sweep + batch + apply + canary.
- `packages/harness-core/src/gc/frontmatter.ts` — freshness pass.
- `packages/harness-core/src/gc/generator-drift.ts` — generated-artifact pass.
- `packages/harness-core/src/gc/stub-hits.ts` — catalog hit pass.
- `packages/harness-core/src/gc/doc-gardening.ts` — orphan/dead-link pass.
- `packages/harness-core/src/gc/quality-update.ts` — score writer.
- `packages/harness-core/src/gc/classify.ts` — auto-merge classifier (safe / code / high-stakes).
- `packages/harness-core/src/gc/canary.ts` — workflow.md template canary.

### 3.4 Sensors (state-layer evaluators)
- `packages/harness-core/src/sensors/index.ts` — full surface.
- `packages/harness-core/src/sensors/types.ts` — ProjectGlobs, SensorFinding, etc.
- `packages/harness-core/src/sensors/catalog.ts` — stub-catalog loader.
- `packages/harness-core/src/sensors/stub-catalog.ts` — pattern evaluator.
- `packages/harness-core/src/sensors/decisions.ts` — decision-assertion evaluator.
- `packages/harness-core/src/sensors/structural.ts` — DTO + route-handler sensors.
- `packages/harness-core/src/sensors/attestation.ts` — attestation cross-check.
- `packages/harness-core/src/sensors/diff.ts` — git-diff helper.
- `packages/harness-core/src/sensors/runner.ts` — composes the above.
- `packages/harness-core/src/sensors/remediation.ts` — failure → prompt formatter.

### 3.5 MCP surface (the public API)
- `packages/harness-core/src/mcp/index.ts` — server + context + path-allowlist barrel.
- `packages/harness-core/src/mcp/server.ts` — server bootstrap.
- `packages/harness-core/src/mcp/tools/index.ts` — registers all 18 tools.
- `packages/harness-core/src/mcp/tools/*.ts` — one file per tool. Read all 18:
  - `decision-get.ts` `decisions-in-scope.ts` `decisions-for-symbol.ts`
  - `invariant-get.ts` `invariants-in-scope.ts`
  - `canonical-for-topic.ts` `ground-get.ts` `get-full.ts`
  - `search.ts` `timeline.ts` `query-history.ts`
  - `supersedes-chain.ts`
  - `append.ts` `archive.ts` `record-decision.ts` `record-run-event.ts` `drop-task.ts`
  - `ask-operator.ts`
- `packages/harness-core/src/mcp/path-allowlist.ts` — write-allowed paths + historical-zone deny list.
- `packages/harness-core/src/mcp/schemas.ts` — zod schemas per tool.
- `packages/harness-core/src/mcp/errors.ts` — error envelope.

Also: `docs/MCP_SURFACE.md` — the documented contract. Cross-reference with the actual implementation. Drift between doc and code is a finding.

### 3.6 Init + adoption flow
- `packages/harness-core/src/init/index.ts` — surface.
- `packages/harness-core/src/init/init.ts` — wizard entry.
- `packages/harness-core/src/init/seed.ts` — copies templates + applies placeholder substitution.
- `packages/harness-core/src/init/walker.ts` — gitignore-aware repo summarizer.
- `packages/harness-core/src/init/mapper.ts` — Tier-2 LLM mapper (proposes pilot_module + project_globs + sensors).
- `packages/harness-core/src/init/workflow-block.ts` — round-trips the per-project `<slug>:` extension block.
- `packages/harness-core/src/init/secrets.ts` — env file management.
- `packages/harness-core/src/init/detect.ts` — stack/hook signature detection.
- `packages/harness-core/src/init/prompts.ts` — squares-into-square-holes inquirer wrappers.
- `packages/harness-core/src/init/setup-runners.ts` — whisper / ollama / etc downloads.

### 3.7 Templates that ship
- `packages/harness-core/templates/` — full tree.
  - `.harness/config/workflow.md` — the load-bearing policy file (YAML frontmatter + Markdown prompt body).
  - `.harness/config/sensors.yaml` — sensor registry.
  - `.harness/config/stub-patterns.yaml` — Layer-A stub catalog.
  - `.harness/config/trust-policy.yaml` — per-command confirmation policy.
  - `.harness/ground/manifest.yaml` — empty seed.
  - `.harness/ground/canonical-map/topics.yaml` — topic → canonical-doc mapping seed.
  - `.archive/README.md` — historical-zone marker.

### 3.8 The doc surface itself
- `docs/ARCHITECTURE.md` — locked layered model.
- `docs/PRIMER.md` — concept primer; §4 grounding-context layer; §11 anti-patterns; §13 backprop; §10 honest-agent invariants.
- `docs/MCP_SURFACE.md` — MCP tool contract.
- `docs/FILESYSTEM_LAYOUT.md` — `.harness/` layout for adopters.
- `docs/WORKFLOW_GUIDE.md` — operator UX rules + tier ladder + slash surface.
- `docs/UAT_PIPELINE.md` — Layer U pipeline (runtime concern; skim only).
- `docs/INTEGRATION_PLAN.md` — historical phase plan; carries a "superseded framing" banner now.
- `docs/QUESTIONS.md` — residual open items.

### 3.9 What to look for during the audit

Open questions to pressure-test for each subsystem:
1. **Cohesion.** Is each file's responsibility stated in 1 sentence? Anything bloated?
2. **Redundancy.** Any two files that overlap (e.g. multiple frontmatter parsers)?
3. **Naming drift.** Anything named for a now-superseded framing (e.g. "Symphony-shaped", per-task-channel, runtime-flavored).
4. **MCP-tool inventory.** Are all 18 tools needed? Is there overlap (e.g. ground-get vs get-full)? Is anything missing for SessionStart context-injection?
5. **Doc-vs-code drift.** Does `docs/MCP_SURFACE.md` match the actual tool registrations? Does PRIMER §4.2 layout match the templates? Does WORKFLOW_GUIDE's slash surface match `harness-frontend-discord`'s SLASH_COMMAND_NAMES?
6. **Templates.** Are templates project-agnostic? Any leftover `sample-project` references? (check-layout already enforces this; spot-check anyway.)
7. **Schemas.** Any zod schema in core whose shape isn't used elsewhere? Any field in a schema that no consumer reads?
8. **The "what should SessionStart inject?" question.** Walk through what context an agent would need to pick up a session in a partly-progressed harness adoption. Decisions in scope of cwd? §V invariants? Current task spec from `.harness/tasks/active/`? Quality grades? Pending decision drafts in `_inbox/`? Open questions?

## 4. Deliverables for this session

### 4.1 Audit memo

Write `docs/_review/STATE_AUDIT_2026-05-04.md` (create the dir if needed). Structure:

```
---
type: audit
status: draft
audience: dual
generated: 2026-05-04
audited-commit: 9fe2b95
---

# State + doc surface audit — Claude Code integration prep

## Summary
<3-5 lines. What's healthy, what's bloated, what's missing.>

## Per-subsystem findings
### ground/
<bullets — issues, redundancies, gaps>
### decision-capture/
…
### gc/
…
### sensors/
…
### mcp/ (18 tools)
<table: tool | doc-match | redundant-with | needed-for-SessionStart>
### init/
…
### templates/
…
### docs/
<table: file | drift-from-code | recommended-action>

## Recommendations (ranked)
1. <highest-leverage cleanup>
2. <next>
…

## Open questions for operator
<bullets — things only the operator can decide>
```

### 4.2 SessionStart payload spec

Write `docs/SESSIONSTART_SPEC.md`. Structure:

```
---
type: spec
status: proposal
audience: dual
generated: 2026-05-04
---

# SessionStart hook payload

## What Claude Code sends to the hook
<format reference — payload shape per official Claude Code docs>

## What `harness hook session-start` returns
<the JSON shape that gets injected as additional context>

## What's IN the payload
<bullets — concrete fields, why each>
- decisions_in_scope[]: array of {id, title, scope_globs, status} for decisions whose scope overlaps the session's cwd
- invariants_active[]: array of {id, slug, sensor_path}
- current_task: optional — pulled from .harness/tasks/active/<id>/spec.tightened.md
- quality_grades_tail: top 3 weakest modules
- pending_drafts[]: anything in .harness/ground/decisions/_inbox/
- two_zone_reminder: short instruction line — "default reads = canonical paths; for archive, call harness_query_history"

## What's NOT in the payload (and why)
<bullets — things considered + rejected>

## Token budget
<estimate — payload should fit comfortably; truncation strategy if not>

## Failure modes
<bullets — what happens if .harness/ doesn't exist (project not adopted yet); if MCP server isn't configured; if frontmatter is malformed>

## Test plan
<bullets — how we verify this works in this repo end-to-end>
```

These two artifacts are the gate before any hook code is written. Stop after delivering them and confirm with the operator before implementing.

## 5. Operator profile (binding — applies to your replies + commits)

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. Lead with answer/action. No filler. Caveman ultra mode is active for chat replies; commits + PRs + docs are full English. |
| Decisions | Fast-intuitive. Don't present options unless explicitly asked. When operator states a decision, treat it as final. |
| Explanations | Concise. Root cause in 1-2 sentences then fix. |
| UX Philosophy | Design-conscious. UX = functional correctness. |
| Vendor Choices | Opinionated. Don't suggest alternatives unless they avoid real risk. |
| Env vars | Hates env vars. Hardcoded model IDs in code = correct. |
| Tests | "Tests are shitware. Only E2E with real DB matters." Drop the test framing entirely. Sensors and E2E only. |
| Backward compat | Hates backward compat. No transition shims. Hard cutovers. |
| Inquirer | Use `@inquirer/prompts` for all CLI dialogs. Never hand-roll readline. |
| Mobile mode | When operator is on mobile, AskUserQuestion options get truncated. Switch to chat-mode K/R/U/M with concise option labels. |

Style rules learned recently (preserve in your work):
- **No inline `import("…").Type` patterns.** Top-level `import type { … }` only. Operator dislikes the inline form. The only valid `import("…")` in code is `await import("…")` for genuine dynamic runtime imports.
- **No PreToolUse hooks** unless soft enforcement has provably failed. Convention + MCP tool surface > tool-call interception.

## 6. What NOT to do

- Do not start writing `harness hook` code, plugin manifests, `.mcp.json` templates, or `.claude/settings.json` templates before the audit memo + SessionStart spec land and the operator approves direction.
- Do not propose PreToolUse hooks. Two-zone separation = SessionStart instruction + `harness_query_history` MCP tool.
- Do not re-debate the four §3 departures (mirror, voice, sensors, prompt → core). They're locked.
- Do not write inline `import("path").Type` references.
- Do not refactor while auditing. Audit first, recommend, then refactor in a separate commit only after operator buy-in.
- Do not write tests in the implementation phase. Sensors + smokes only.
- Do not treat `docs/INTEGRATION_PLAN.md` as authoritative — it has a "superseded framing" banner. The current locked model is `docs/ARCHITECTURE.md`.

## 7. References

- `docs/ARCHITECTURE.md` — locked layered model + four-package boundary.
- `docs/PRIMER.md` — concepts, anti-patterns (§11), §V backprop (§13), grounding-context layer (§4), two-zone separation (§4.4).
- `docs/MCP_SURFACE.md` — MCP tool contract (audit candidate; check vs code).
- `docs/FILESYSTEM_LAYOUT.md` — adopted-project layout.
- `docs/WORKFLOW_GUIDE.md` — operator UX + tier ladder + slash surface.
- `docs/QUESTIONS.md` — residual open items.
- Prior RESUME_PROMPT (commit 9dd0557 `docs/_history/` if archived) — L01–L50 architectural locks.
- Migration commit: `git show 9fe2b95` for the §3 departures rationale.

## 8. Fast-start checklist

```
□ Read this file end-to-end.
□ Read docs/ARCHITECTURE.md.
□ Read docs/PRIMER.md (skim §11, §4, §10, §13).
□ Read docs/MCP_SURFACE.md.
□ git log --oneline -3  → confirm 9fe2b95 is HEAD.
□ pnpm -r build  → confirm green.
□ Walk every file in §3 of this brief. Take notes.
□ Write docs/_review/STATE_AUDIT_2026-05-04.md (§4.1).
□ Write docs/SESSIONSTART_SPEC.md (§4.2).
□ Confirm to operator in 4-6 lines:
    "Audit memo written: <top finding>, <top finding>, <top finding>.
     SessionStart spec written: payload includes <X,Y,Z>.
     Recommend we do <next concrete step>. Approve?"
□ Wait for explicit approval before implementing any hook code.
```

End of brief.
