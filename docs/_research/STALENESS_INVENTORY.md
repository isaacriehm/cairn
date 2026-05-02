---
type: research
audience: dual
status: complete
generated: 2026-05-01
purpose: docs-purge planning input
agent: Agent C — staleness surveyor
---

# Docs Staleness Inventory

Audit of every load-bearing markdown surface in the repo plus `.planning/` lifecycle artifacts. Each row classified, evidence cited, action recommended.

Classifications: `canonical` · `stale-supersedable` · `stale-rotted` · `transient` · `orientation`.

---

## 1. Top-level signals

### Total volume

| Bucket | Files | Lines (approx) |
|---|---:|---:|
| Root-level `*.md` | 8 | 1,799 |
| `docs/**` | 38 | 8,748 |
| `.claude/rules/**` | 14 | 2,252 |
| `.planning/**` | 167 | not counted |
| `core/REVIEW_DECISIONS.md` + `core/RESUME_PROMPT.md` | 2 | 2,701 (309 KB + 38 KB) |
| **TOTAL load-bearing** | **62** | **~15,500** |
| `.planning/` (transient/checkpoint) | 167 | many thousand |

### Top 5 — most likely to MISLEAD a fresh agent

1. **`docs/remediation/README.md`** — table of "active programs" (`crm-communications/`, `crm-domain-model/`, `uat-closeout/`) all of which were **hard-deleted** in commit `9669ca6` (per `.planning/redo-2026-04-24/HANDOFF.md`). README still claims they're "Cleanup complete — remaining phases executing." Pure rotted pointer.
2. **`STATE.md`** — dated 2026-04-23. Lists in-flight items (`crm-domain-model remediation Phase 2+`, `crm-communications` RED) that were closed/deleted ~2026-04-24. Last-shipped section stops at 2026-04-23 — silent on Jameson reviews, persona renames, mobile removal, W6/W7 deals-map, Brand Guidelines v3.
3. **`docs/decisions/project-history.md`** — frontmatter says `status: complete, date: 2026-04-16`. Phases listed end at 17. Says "Tier 2 shipped: Microsoft 365, Zapier, DocuSign" but Zapier is not actually wired (per `docs/engineering/integrations.md` "REST hook dispatch infrastructure built but no external provider connected"). References memory files (`memory/project_*`) that are not in this repo.
4. **`docs/design/mobile-flows.md`** (642 lines) — Mobile API contract for the Swift iOS app. The Swift app was **deleted** in commit `a3e26be Cleanup + Remove Mobile App (Swift)`. Document still presents itself as live reference material.
5. **`docs/engineering/api-map.md`** (1,823 lines) — claims "37 controller classes · ~220 routes · ~160 DTO classes". Frontmatter `last-verified: 2026-04-23`. Many DTOs and routes have shipped/changed since (W6/W7 deals-map, Jameson 28-item review wave, Caravans broker-tour). Single-file size makes drift inevitable.

### Top 5 — most worth treating as CANONICAL context

1. **`AGENTS.md`** (128 lines) — root coding law. Active. Concise. Verified against codebase (matches Drizzle/NestJS layout, real submodule list). Fresh agents should always load.
2. **`.claude/rules/*.md`** (14 files, 2,252 lines) — typescript-law, backend, frontend, schema, integrations, mail-templates, phone-ai, site, output-format, fix-standard, event-naming, ai-subsystem, ai-comments-{front,back}end. All concise, current, code-aligned. The rules system is the strongest doc surface in the repo.
3. **`CODEBASE_META_INDEX.md`** (476 lines, generated 2026-05-01) — fresh, machine-generated, line-count survey of every core/ module. Highest fidelity snapshot of where the code actually is.
4. **`docs/design/brand/Brand Guidelines.md`** (705 lines) — Identity System v3, dated and canonical. Cross-checked: matches `--accent #1A8A72`, Geist 500, all surfaces. The brand source-of-truth.
5. **`JAMESON-PRIME.md`** (161 lines) — pricing, personas, milestones, working tone, all current. Self-contained context for a non-engineer co-founder. Useful as live product brief.

---

## 2. Classification table — root-level docs

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `AGENTS.md` | 128 | dual | **canonical / orientation** | Cross-checked: 4 submodules (core/platform/site/phone-ai) match repo, ports match, rule paths exist, `prompt-templates.ts` exists. Recent (2026-05-01). | Keep. Treat as primary entry. |
| `CLAUDE.md` | 1 | orientation | **orientation** | Just `@AGENTS.md` re-export. Trivial, correct. | Keep. |
| `README.md` | 36 | dual | **orientation** | Submodule list matches `.gitmodules`. Quick start sequence valid. | Keep, light. |
| `STATE.md` | 29 | dual | **stale-rotted** | Dated 2026-04-23. Lists "in flight" remediation programs that were **deleted** in `9669ca6`. Last-shipped log stops 8+ days before today. References `docs/remediation/crm-domain-model/` which does not exist. | **Rewrite or archive.** Replace with current state. Top-3 misleading file. |
| `CODEBASE_META_INDEX.md` | 476 | ai-only | **canonical (transient)** | Fresh (today). Module-by-module hotspot index, accurate against `core/src/`. | Keep but treat as snapshot — regenerate periodically. |
| `JAMESON_CHAT_REVIEW.md` | 683 | dual | **transient (canonical for product wave)** | Live running log of Jameson product feedback through 2026-04-30 with Implementation Sequencing table. References active commit IDs (`44c387d`, etc.). Dense, useful. | Keep until Jameson wave complete; then archive to `docs/decisions/`. |
| `JAMESON-PRIME.md` | 161 | dual | **canonical** | Pricing, personas, sequencing align with `docs/product/pricing.md` and current product positioning. Useful primer. | Keep. |
| `PLATFORM-AUDIT.md` | 285 | ai-only | **transient** | Dated 2026-04-30. Findings list (P0/P1/P2 with file:line) is a fix-tracker. Many likely fixed, many likely not. No status field. Lifecycle = checkpoint. | Verify against current code, then either (a) collapse remaining items into an issue queue or (b) timestamp + freeze + move to `.planning/`. |

---

## 3. Classification table — `docs/`

### `docs/` (top)

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/README.md` | 17 | dual | **orientation** | Routes table to product/design/engineering/domain/remediation/decisions/ops. Remediation pointer is rotted (see below) but rest valid. | Keep, trim remediation row. |

### `docs/product/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/product/README.md` | 8 | orientation | **orientation** | Trivial router. | Keep. |
| `docs/product/positioning.md` | 53 | dual | **canonical** | Matches JAMESON-PRIME positioning, Brand Guidelines. "Pre-release" status correct. | Keep. |
| `docs/product/pricing.md` | 140 | dual | **canonical** | Matches JAMESON-PRIME pricing tiers exactly. Numbers consistent. | Keep — single source of pricing math. |
| `docs/product/personas.md` | 30 | dual | **stale-supersedable** | Persona names "Sarah" (P1) and unnamed P2. Memory note (2026-04-29) says Sarah Chen retired, replaced with Kelly Morrison + Brian Carlson. Not yet reflected here. | Update names or align with site personas. |
| `docs/product/roadmap.md` | 13 | dual | **canonical (sparse)** | Milestone-level only. M0 shipped/M1 in flight/M2-M4 not started — accurate. | Keep, refresh M1 status. |

### `docs/engineering/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/engineering/README.md` | 10 | orientation | **orientation** | Router. | Keep. |
| `docs/engineering/overview.md` | 171 | dual | **canonical (lightly stale)** | `last-verified: 2026-04-23`. Frontmatter is the canary — needs re-verification. Hard constraints all match `.claude/rules/`. Repeats lots of `AGENTS.md` content (duplication risk). | Refresh `last-verified`; consider trimming the duplication w/ AGENTS. |
| `docs/engineering/ai-subsystem.md` | 527 | dual | **canonical (verify)** | `last-verified: 2026-04-23`. Topology diagram (SharedCoreCommandAdapter → ExecutionEngine → ReviewStateMachine) matches `core/src/ai-execution/` reality. `AiContextService` file exists. Lists "fix required" items in voice-profile, behavior — unclear if shipped. | Walk fix-required items against current code; refresh `last-verified`. |
| `docs/engineering/data-model.md` | 758 | dual | **canonical (verify)** | `last-verified: 2026-04-23`. Tables marked NEW (`merged_contacts_log`, `relationship_edges`, `mls_*`, `deal_milestones`, `call_highlights`, `action_executions`, `review_events`) all confirmed present in `core/src/drizzle/schema/`. Notes `value` deprecated in deals — verified gone in schema, still mentioned here. | Refresh; remove "NEW" markers (they're old now). 71 schema files, doc spans most. |
| `docs/engineering/api-map.md` | 1,823 | dual | **stale-supersedable** | `last-verified: 2026-04-23`. Massive endpoint catalog. Drift risk extreme; W6/W7 commits, Jameson wave shipped after this date. Single-file size reduces utility. | Either (a) auto-generate from `core/openapi.json`, or (b) split per-module + `last-verified` per file. **High maintenance cost as-is.** |
| `docs/engineering/integrations.md` | 109 | dual | **canonical** | `last-verified: 2026-04-23`. `OAuthBaseService`, `EmailSyncBaseService`, `enc:v1:` format, JWT state — all match `.claude/rules/integrations.md` and observed code patterns (e.g. `core/src/integrations/`). Known gaps section honest about Zapier. | Keep. |
| `docs/engineering/prompt-governance.md` | 369 | dual | **stale-supersedable** | `status: draft-v1, generated: 2026-04-16`. Lists "6 inline prompt sites" — RC-F (commit `d27dd24`) shipped per HANDOFF.md, possibly closing some. Targets phases that may have changed scope. | Walk inline-prompt list against current code (`core/src/assistant/`, `bot-stream.service.ts` etc.); upgrade or close. |
| `docs/engineering/testing.md` | 172 | dual | **stale-supersedable / aspirational** | `status: draft-v1, generated: 2026-04-16`. Describes coverage targets, CI gates, /04_EPICS_AND_TICKETS/ directory references. References paths that don't exist. Aspirational rather than current. | Mark as "target state" or rewrite as actual current testing posture. |

### `docs/domain/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/domain/README.md` | 10 | orientation | **orientation** | Router; references `remediation/crm-communications/` which is gone. | Keep, update link. |
| `docs/domain/model.md` | 325 | dual | **canonical (lightly stale)** | `last-verified: 2026-04-23`. Entity tree, contact lifecycle stages, deal participants enum — all correct. References "see `remediation/crm-domain-model/`" which is **deleted**. | Keep core content; remove dead remediation pointer. |
| `docs/domain/communications.md` | 111 | dual | **canonical** | Webhook/SMS endpoint catalog matches actual `core/src/telephony/` and `core/src/sms/` modules. Honest about current gaps. | Keep. |

### `docs/design/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/design/README.md` | 8 | orientation | **orientation** | Router. | Keep. |
| `docs/design/design-context.md` | 307 | dual | **canonical (verify)** | `last-verified: 2026-04-23`. Source-of-truth pointer is Brand Guidelines (good). Some content overlaps Brand Guidelines (duplication). Confidence-tier table contradicts AI subsystem rule "no confidence" (mentions "Tier 1/2/3 confidence badges"). | Resolve confidence-tier contradiction. Trim duplication with Brand Guidelines. |
| `docs/design/mobile-flows.md` | 642 | dual | **stale-rotted** | Documents Swift iOS app API contract. **Swift app was deleted** in `a3e26be`. Repo has no `mobile/` directory. Top-3 misleading file. | Move to archive or delete. Optionally salvage flow descriptions that survive into a future mobile-deferred rebuild brief. |
| `docs/design/mobile-deferred.md` | 95 | dual | **stale-supersedable** | `status: deferred, decision-date: 2026-04-16`. References `mobile/MyPalCRM/` which is gone. Lists "salvageable" Swift files — moot. | Replace with one-line decision: "mobile deferred; will be rebuilt fresh post-pilot." |
| `docs/design/a11y-known-issues.md` | 28 | dual | **canonical (drifting)** | Last update 2026-04-17. Tracker style — could grow stale silently. | Keep, audit periodically. |
| `docs/design/brand/Brand Guidelines.md` | 705 | dual | **canonical** | v3.0, 21 sections, recent (post-rebrand `462c3f2`). Values match `.claude/rules/site.md` exactly. | Keep — strongest brand surface. |
| `docs/design/brand/assets/README.md` | 77 | dual | **canonical** | Asset routing for brand pack. | Keep. |

### `docs/design/platform-rebuild-primer/` (sub-cluster — 8 files, 1,932 lines)

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `README.md` | 50 | orientation | **transient (active project artifact)** | "Upload this folder to Claude Design when restarting platform/ frontend." Defines the kit lifecycle. | Decide if rebuild project is live; if not, archive. |
| `00-claude-design-start-prompt.md` | 36 | ai-only | **transient** | Prompt for Claude Design. | Keep with project. |
| `01-product-and-design-context.md` | 134 | dual | **stale-supersedable** | Re-states positioning + brand voice. Overlaps with `positioning.md` + `design-context.md` + Brand Guidelines. Drift risk. | Either consolidate or accept duplication as project-scoped. |
| `02-information-architecture.md` | 247 | dual | **canonical (verify)** | Routes table matches actual `platform/src/app/(app)/(dashboard)/`: brain, calendar, calls, caravans, contacts, dashboard, deals, marketing, open-houses, pipeline, presentations, properties, review, settings, studio, tasks. ✓ | Keep, refresh. |
| `03-page-feature-checklists.md` | 510 | dual | **transient** | Page-by-page rebuild punch list. | Keep with project. |
| `04-global-systems-and-components.md` | 314 | dual | **transient** | App shell + Assistant + cmd palette. | Keep with project. |
| `05-data-api-and-state-map.md` | 424 | dual | **transient (verify)** | Data/API expectations for frontend. May drift vs `api-map.md`. | Keep with project. |
| `06-rebuild-workflow-and-acceptance.md` | 217 | dual | **transient** | Rebuild sequencing + acceptance gates. | Keep with project. |

> **Cluster note:** This 8-file primer is a self-contained project kit. Healthy as a unit, but parts duplicate `docs/product/positioning.md`, `design-context.md`, and `engineering/api-map.md`. Treat as transient project artifact rather than canonical living docs.

### `docs/decisions/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/decisions/README.md` | 31 | orientation | **orientation** | MADR-lite template + index. | Keep. |
| `docs/decisions/0001-example.md` | 23 | dual | **canonical** | "No AI confidence as write gate" — Phase D decision. Matches `.claude/rules/ai-subsystem.md`. | Keep. |
| `docs/decisions/project-history.md` | 86 | ai-only | **stale-rotted** | `status: complete, date: 2026-04-16`. Phases stop at 17. Refers to `memory/project_*` files outside this repo. Claims Zapier "Tier 2 shipped" — contradicts current state per `integrations.md`. | Either freeze with explicit "as of 2026-04-16" disclaimer, or rewrite as ADR-style append-only log. |

### `docs/remediation/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/remediation/README.md` | 19 | dual | **stale-rotted** | Lists `crm-communications/`, `crm-domain-model/`, `uat-closeout/` programs. **All three subdirectories are deleted** (commit `9669ca6` per HANDOFF). Says "Cleanup complete — remaining phases executing." Folder is empty besides this README. **Most misleading single file in repo.** | **Delete or rewrite immediately.** Top-1 misleading. |

### `docs/ops/`

| Path | Lines | Audience | Classification | Evidence | Action |
|---|---:|---|---|---|---|
| `docs/ops/README.md` | 8 | orientation | **orientation** | Honest "empty for now" placeholder. | Keep. |
| `docs/ops/observability.md` | 141 | dual | **stale-supersedable / aspirational** | `status: draft-v1, generated: 2026-04-16`. Alert table, audit log, Phase 4 handoffs — likely target state. Discord webhook integration unclear if shipped. References `automation_dnc_checks` which exists in schema. | Mark as target-state plan or refresh against actual ops posture. |

---

## 4. Classification table — `.claude/rules/`

| Path | Lines | Classification | Notes |
|---|---:|---|---|
| `typescript-law.md` | 52 | **canonical** | Universal type law. Used by every agent. |
| `backend.md` | 88 | **canonical** | DTOs, services, controllers, errors, DB. Matches `core/`. |
| `frontend.md` | 66 | **canonical** | React/$api/forms. Matches `platform/`. |
| `schema.md` | 53 | **canonical** | Two-tier migration — code matches. |
| `ai-subsystem.md` | 23 | **canonical** | Confidence freeze + shared core constraints. |
| `integrations.md` | 53 | **canonical** | Token encryption + OAuth pattern. |
| `mail-templates.md` | 58 | **canonical** | `@react-email/components` constraints. |
| `event-naming.md` | 36 | **canonical** | `EVENT_LABELS` cross-reference rule. |
| `phone-ai.md` | 24 | **canonical** | Fastify + OpenAI Agents SDK constraints. |
| `site.md` | 62 | **canonical** | Brand v2 colors, naming, copy rules. |
| `output-format.md` | 74 | **canonical** | Tier rules — heavily referenced. |
| `fix-standard.md` | 100 | **canonical** | Bug lifecycle + repeat-failure rigor. |
| `ai-comments-backend.md` | 49 | **canonical** | `// AI:` comment standard. |
| `ai-comments-frontend.md` | 65 | **canonical** | Frontend variant. |

> Strongest doc surface in repo. All current, code-aligned, terse. Leave alone.

---

## 5. Classification table — `.planning/` (one level deep)

| Path | Type | Classification | Notes |
|---|---|---|---|
| `.planning/active/W7-deals-map-first/PLAN.md` | active | **transient** | Live workstream — pipeline deals map. Matches commit `3b5fcf8 feat(W7): deals map-first pipeline`. |
| `.planning/deep-audit/SUMMARY.md` + 5 siblings + `cartography/` (19 files) + `twilio/` (3 files) | audit | **transient** | 2026-04-24 audit checkpoint. Heavy file count. Keep until findings adjudicated. |
| `.planning/jameson-fixes/` (5 files: pipeline-map, assistant, ui-audit, verification, mls-broker-tour) | fix-tracker | **transient** | 2026-04-30. Aligns with Jameson 28-item review wave (commit `ad6ba09`). Live work. |
| `.planning/redo-2026-04-24/` (~11 root files + audits/(28) + fixes/(21) + W6/(17) + W6-AUDIT/(11) + smoke/(25) + personas/(15)) | major-redo | **transient (high signal)** | The redo cycle that **deleted the old remediation folders**. Hugely informative for understanding current state. Keep frozen — do not delete; reference. |
| `.planning/research/meet-integration/` (6 files) | research | **transient** | Google Meet integration research, 2026-04-29. |
| `.planning/ui-reviews/site-20260424-211959/` (14 PNGs) | screenshots | **transient** | Site UI review screenshots. |

> `.planning/` is correctly transient. The redo-2026-04-24 sub-tree is the canonical record of the doc-cleanup that left `docs/remediation/` empty — keep it readable.

---

## 6. Classification — `core/` markdown checkpoints

| Path | Size | Classification | Notes |
|---|---:|---|---|
| `core/REVIEW_DECISIONS.md` | 309 KB / 2,252 lines | **transient (heavyweight)** | Append-only log of architecture/code review decisions. Living artifact during active core review. Per user request, not read in detail. |
| `core/RESUME_PROMPT.md` | 38 KB / 449 lines | **transient** | "Drop into a new session to continue the review" — a session handoff. |

Both are session-level continuity tools. Useful, but should never be load-bearing for fresh agents not engaged in the core review.

---

## 7. Duplication / fragmentation clusters

Fresh agents pulling context will hit overlapping information across these groups. Each cluster is a candidate for consolidation.

| Cluster topic | Files involved | Symptom |
|---|---|---|
| **Product positioning** | `JAMESON-PRIME.md` · `docs/product/positioning.md` · `docs/design/design-context.md` · `docs/design/platform-rebuild-primer/01-product-and-design-context.md` | Same thesis, voice, and "other CRMs summarize, mypal updates" line in 4 files. Drift risk per change. |
| **Pricing** | `JAMESON-PRIME.md` · `docs/product/pricing.md` | Identical tier tables. Single duplication, manageable. |
| **Brand identity** | `docs/design/brand/Brand Guidelines.md` · `docs/design/design-context.md` · `.claude/rules/site.md` | Brand colors + name rules in three places. site.md is the agent-facing rule, Brand Guidelines is the source. design-context.md repeats. |
| **Coding rules** | `AGENTS.md` · `.claude/rules/*.md` · `docs/engineering/overview.md` | overview.md re-states many `.claude/rules/` items. Pure duplication. |
| **AI subsystem architecture** | `docs/engineering/ai-subsystem.md` (527 lines) · `.claude/rules/ai-subsystem.md` (23 lines) · `docs/engineering/prompt-governance.md` (369 lines) · `docs/decisions/0001-example.md` | 4 files describing the same shared-core write path. Decision record is concise; ai-subsystem.md is sprawling. |
| **Schema / data model** | `docs/engineering/data-model.md` (758 lines) · `.claude/rules/schema.md` (53 lines) · `core/src/drizzle/schema/index.ts` | data-model.md has 70+ tables hand-listed against 71 schema files. High-effort to keep aligned. |
| **API surface** | `docs/engineering/api-map.md` (1,823 lines) · OpenAPI spec at `core/openapi.json` | Hand-written endpoint catalog parallel to generated OpenAPI. |
| **Mobile (deleted)** | `docs/design/mobile-flows.md` (642 lines) · `docs/design/mobile-deferred.md` (95 lines) | Both reference deleted Swift app. |
| **Remediation (deleted)** | `docs/remediation/README.md` · `STATE.md` · `docs/decisions/project-history.md` · `docs/domain/model.md` · `docs/domain/communications.md` (cross-ref) | All link to deleted `docs/remediation/{crm-domain-model,crm-communications,uat-closeout,next}/`. |
| **Resume / session continuity** | `core/RESUME_PROMPT.md` · `.planning/redo-2026-04-24/RESUME.md` · `.planning/redo-2026-04-24/RESUME-PROMPT.md` · `.planning/redo-2026-04-24/RESUME-STATE.md` · `.planning/redo-2026-04-24/SESSION-REPORT.md` | Five handoff files spanning the redo cycle. Multiple "RESUME-*" filenames is its own anti-pattern. |

---

## 8. Vibe-coded / agent-debris signals

Patterns that indicate AI-generated session output rather than curated permanent doc.

| Pattern | Examples | Action |
|---|---|---|
| Filename timestamps | `.planning/ui-reviews/site-20260424-211959/`, `.planning/redo-2026-04-24/` | OK in `.planning/`. Banned in `docs/`. |
| Multiple "RESUME-*" / "RESUME_PROMPT" | `core/RESUME_PROMPT.md`, `.planning/redo-2026-04-24/{RESUME.md, RESUME-PROMPT.md, RESUME-STATE.md}` | Collapse — one resume artifact per project. |
| "redo", "checkpoint", "audit-N" naming | `.planning/redo-2026-04-24/`, `JAMESON_CHAT_REVIEW.md`, `PLATFORM-AUDIT.md` (root), `W6-AUDIT/`, `cartography/X1.md..X4.md` | Acceptable in `.planning/`. Promote to `docs/decisions/` if surviving content; otherwise archive. |
| Header restatements ("# CODEBASE_META_INDEX — `core/` Backend\n\n**Generated:** ... **Scope:** ...") | `CODEBASE_META_INDEX.md`, `PLATFORM-AUDIT.md`, multiple `.planning/**` files | Acceptable for transient artifacts; flag becomes "this was AI-generated" — agents should know not to treat as canonical. |
| Frontmatter `status: draft-v1, generated: 2026-04-16` (not refreshed) | `prompt-governance.md`, `testing.md`, `mobile-deferred.md`, `observability.md` | Set `last-verified` and bump regularly, or mark as target-state. |
| Aspirational tables of "Phase N handoffs" | `observability.md` Phase 4 handoffs | Either ticket them in real tracker or remove. |
| Pointer rot — links to deleted folders | `STATE.md`, `docs/remediation/README.md`, `docs/domain/model.md`, `docs/decisions/project-history.md` | Mass-fix in one cleanup. |

---

## 9. Code-state spot-check verifications

Verifying claims in docs against actual repo state.

| Claim | Source doc | Verification | Result |
|---|---|---|---|
| `core/src/ai-context/ai-context.service.ts` exists | `ai-subsystem.md` | `find core/src -name "ai-context.service.ts"` | ✓ exists |
| `core/src/ai-execution/shared-core-command.adapter.ts` exists | `ai-subsystem.md`, `CODEBASE_META_INDEX.md` | `ls core/src/ai-execution/` | ✓ exists, ~2,471 lines |
| `core/src/ai-decision/review-state.machine.ts` exists | `ai-subsystem.md` | `ls core/src/ai-decision/` | ✓ exists |
| `core/src/ai-generation/prompt-templates.ts` exists | `AGENTS.md`, `prompt-governance.md` | `ls core/src/ai-generation/` | ✓ exists |
| `merged_contacts_log` schema table | `data-model.md` | `find ... merged-contacts-log.schema.ts` | ✓ exists |
| `relationship_edges` schema table | `data-model.md` | `find ... relationship-edges.schema.ts` | ✓ exists |
| `value` deprecated in deals (alias for listPrice) | `data-model.md` | `grep value deals.schema.ts` | ✓ `value` gone, only `listPrice` + `appraisedValue` present |
| `lifecycleStage` + `contactRole` split | `JAMESON-PRIME`, `data-model.md` | `grep lifecycleStage contacts.schema.ts` | ✓ confirmed |
| `TWILIO_AI_PHONE_NUMBER` removed | `project-history.md` | `grep -r TWILIO_AI_PHONE_NUMBER core/src` | ✓ no matches |
| `POST /phone-ai/post-call.ingest` route | `overview.md`, `ai-subsystem.md`, `communications.md` | `grep post-call.ingest core/src` | ✓ `core/src/live-call/phone-ai-ingress.controller.ts:185` |
| Platform routes (brain, studio, calendar, etc.) | `02-information-architecture.md` | `ls platform/src/app/(app)/(dashboard)/` | ✓ all 16 routes exist |
| Submodules: `core`, `platform`, `site`, `phone-ai` | `AGENTS.md`, `README.md` | `cat .gitmodules` | ✗ **only `core`, `platform`, `site` are submodules. `phone-ai/` is a regular directory.** |
| Mobile/Swift app exists | `mobile-flows.md`, `mobile-deferred.md` | `find . -name MyPalCRM` | ✗ **deleted in commit `a3e26be`** |
| `docs/remediation/{crm-domain-model, crm-communications, uat-closeout}/` | `STATE.md`, `remediation/README.md`, multiple cross-refs | `ls docs/remediation/` | ✗ **only `README.md` exists; subfolders deleted** |

---

## 10. Recommended docs-purge sequencing

Suggested order for the cleanup pass (not requested to execute — for the planning doc).

| Wave | Action | Targets |
|---|---|---|
| 1 — bleeds | Delete or rewrite the 5 highest-misleading files | `docs/remediation/README.md`, `STATE.md`, `docs/design/mobile-flows.md`, `docs/design/mobile-deferred.md`, `docs/decisions/project-history.md` |
| 2 — pointer rot | Sweep all "see remediation/X" references in `domain/model.md`, `domain/communications.md`, `docs/README.md` | rewrite or remove pointers |
| 3 — duplication | Decide: which of `JAMESON-PRIME.md`, `docs/product/positioning.md`, `docs/design/design-context.md`, `01-product-and-design-context.md` is the source for product framing? Pick one, others link in. | consolidation |
| 4 — generated > hand-written | Replace `docs/engineering/api-map.md` with link to OpenAPI spec or auto-generated module summaries | API surface |
| 5 — frontmatter discipline | Set `last-verified` on all canonical engineering docs; introduce a quarterly re-verification rule | engineering docs |
| 6 — checkpoint hygiene | Move `JAMESON_CHAT_REVIEW.md`, `PLATFORM-AUDIT.md`, `CODEBASE_META_INDEX.md` from repo root into `docs/orchestration/checkpoints/` (or similar); root-level transient docs invite confusion | root |
| 7 — `.planning/` lifecycle | Annotate `.planning/redo-2026-04-24/` as "frozen — historical reference" | planning |

---

## 11. One-paragraph synthesis (60-line target)

The repo carries about 15,500 lines of documentation across 62 load-bearing markdown files (plus 167 transient `.planning/` files). The **strongest surface** is `.claude/rules/*.md` — 14 concise files that are current, code-aligned, and load-on-demand by path. The **weakest surface** is `docs/remediation/`, which still routes agents to three subdirectories that were hard-deleted on 2026-04-24 (`crm-communications/`, `crm-domain-model/`, `uat-closeout/`). `STATE.md` perpetuates the same fiction by listing those programs as "in flight."

Mobile-related docs (`mobile-flows.md` 642 lines, `mobile-deferred.md` 95 lines) describe a Swift iOS app that was deleted in commit `a3e26be`. They will actively mislead a fresh agent.

`docs/engineering/api-map.md` (1,823 lines) is a hand-written endpoint catalog that parallels the generated `core/openapi.json` — it is too large to keep accurate by hand, and `last-verified: 2026-04-23` is already drifting against W6/W7 deals-map and 28-item Jameson wave commits. `docs/engineering/data-model.md` (758 lines) is more current but suffers the same fundamental class problem: hand-maintained mirror of code.

Several files (`prompt-governance.md`, `testing.md`, `observability.md`, `mobile-deferred.md`) have `status: draft-v1, generated: 2026-04-16` and have not been refreshed; their "Phase 4 handoffs" tables describe target state, not current state, but neither labels itself accurately.

`docs/decisions/project-history.md` is presented as "complete" but its phase log stops at Phase 17, claims integrations (Zapier) that aren't actually shipped, and references `memory/project_*` files that don't exist in this repo.

Cluster duplication is heaviest around product framing (positioning + design-context + JAMESON-PRIME + 01-product-and-design-context all repeat the "other CRMs summarize, mypal updates" thesis with slight drift) and AI subsystem architecture (`docs/engineering/ai-subsystem.md` 527 lines + `.claude/rules/ai-subsystem.md` 23 lines + `prompt-governance.md` 369 lines + ADR-0001 all touch the same write-path).

`.gitmodules` lists three submodules (`core`, `platform`, `site`); `phone-ai/` is a regular directory in the repo, but `AGENTS.md` and `README.md` describe it as a peer of the submodules without flagging the difference. Minor but real.

Top-5 files to either rewrite or archive in a first pass: (1) `docs/remediation/README.md` — most misleading single file, (2) `STATE.md` — dated and falsely lists deleted remediation programs, (3) `docs/design/mobile-flows.md` — describes deleted Swift app, (4) `docs/design/mobile-deferred.md` — same, (5) `docs/decisions/project-history.md` — frozen at 2026-04-16 with claims that no longer hold.

Top-5 files to treat as canonical and lean on hard: (1) `AGENTS.md`, (2) the entire `.claude/rules/` tree, (3) `CODEBASE_META_INDEX.md` (fresh, today), (4) `docs/design/brand/Brand Guidelines.md` (v3, post-rebrand, internally consistent), (5) `JAMESON-PRIME.md` (live product brief, internally consistent with pricing.md and personas.md).

Recommendation for the harness: gate "load full docs context" through `.claude/rules/` first, fall through to `docs/engineering/{overview,ai-subsystem,integrations}.md` and `docs/design/brand/Brand Guidelines.md`, and treat `docs/remediation/`, `docs/design/mobile-*.md`, `docs/decisions/project-history.md`, `STATE.md`, `docs/engineering/api-map.md` as quarantined until purged or refreshed. Everything in `.planning/` is correctly transient — leave it alone but never mistake it for canonical.
