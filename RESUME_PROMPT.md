---
type: resume-prompt
status: handoff
audience: ai-only
generated: 2026-05-02
last-updated: 2026-05-02 (after Phase 14 — decision capture flow)
purpose: Drop into a fresh Claude Code session in /Users/user/Documents/DevPlus LLC/06 - Projects/Harness to continue this project where the previous session left off.
---

# Resume Prompt — Harness Project

You are a freshly-spawned agent picking up an in-flight project. Read this file end-to-end before doing anything. Then read `docs/PRIMER.md`. Then confirm to the operator what you've loaded.

## 1. Mission

Build a **portable, generic agent harness for solo developers**. Discord-front-ended. Local Whisper voice input. Filesystem-only state. Honest-agent invariants stack. Direct-commit workflow. Symphony-shaped per OpenAI's open-source spec.

Mypal (a real-estate CRM at `/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`) is the proving ground. The harness package extracts cleanly to any other project via `npx @devplusllc/harness init <repo-dir>`.

**Status:** Implementation in progress. Phase 14 complete — Phases 0–14 all landed (~18.5 founder-days). Phase 15 (trial-run pilot) is next. **Documentation in `docs/` is still the source of truth for design; the code in `harness/` is the runtime that implements it.**

## 1A. Implementation snapshot (binding — verify against `git log` before acting)

The Harness repo is **NOT self-hosted**. It's the source for the published npm package `@devplusllc/harness`. The `.harness/` shape lives in `harness/templates/`; the init script copies it into adopting projects. Do not create `.harness/` or `.archive/` at the repo root.

### Commits landed (most recent first)

| SHA (short) | Phase | What |
|-------------|-------|------|
| _(pending)_ | 14 | Decision capture flow: `harness/src/decision-capture/` (types — DecisionExtractorInput w/ raw_text + author_id + received_at + source + accepted_decisions context + tier; DecisionExtractorOutput w/ subject + summary + scope_globs + supersedes? + candidate_assertions[] (kind+description+parameters loose) + confidence_signal + not_a_decision; DecisionDraft w/ id + draft_path + canonical_path + raw_text; DraftConfirmDecision = commit\|edit\|reject; DecisionCaptureResult); schema — JSON Schema enforcing required fields + assertion kind enum + maxItems:3 candidate cap; prompt — anti-fabrication system: "be the decision-extractor, not the policy author; when in doubt, set not_a_decision=true; emit-only-JSON; supersedes only when input EXPLICITLY revokes prior decision"; id allocator — `allocateDecisionId` scans `.harness/ground/decisions/{,_inbox/}*.md` for highest existing DEC-NNNN incl. drafts AND `.rejected.md` tombstones, returns next monotonic id (per L13.2 — rejected ids burn, never recycled); extractor — `runDecisionExtractor` Tier 1 default (Haiku per workflow.md `decision_extractor: 1`), validates parsed output via isOutput guard; writer — `writeDecisionDraft` mints DEC-NNNN.draft.md frontmatter (status:draft, decided_at, decided_by, scope_globs, supersedes, capture_source, capture_confidence) + body w/ Summary/Original direction/Scope/Candidate assertions sections — candidate_assertions stored under FRONTMATTER `candidate_assertions:` field NOT strict `assertions:` (loose proposals; lifted to `assertions:` only after Phase 14.x refinement so DecisionFrontmatter zod doesn't reject the draft); `acceptDraft` flips status:draft→accepted, moves to canonical, `writeDecisionsLedger` regenerates → assertions become live (when refined), stamps `superseded_by` on referenced prior decision when set; `rejectDraft` writes `.rejected.md` tombstone (NOT delete) so DEC-id is monotonically burned; capture — `runDecisionCapture` orchestrates extract → draft → adapter.requestDialog (🟢 commit / 🟡 edit / 🔴 not-a-decision / E) Other) → accept/edit/reject branch; on extractor `not_a_decision=true` short-circuits without writing draft; on dialog timeout treats as edit so draft survives in `_inbox/` for operator return-trip. Orchestrator wired w/ `isDirectionRow`/`directionTextOf`/`directionAuthorOf`/`directionChannelOf` helpers; `absorbInboxFile` routes slash:command=direction OR free_text:intent=direction rows through `handleDirectionRow` inline (independent of task FIFO; never burns sensors/UAT quota); `OrchestratorOptions.decisionExtractorTier` + `decisionConfirmTimeoutMs` overrides. `smoke:decision-capture` (6 steps — id allocator empty→DEC-0001 + advances past accepted DEC-0003 + draft DEC-0005 → DEC-0006; writeDecisionDraft frontmatter validates incl. status:draft; acceptDraft flips status + ledger contains DEC-0006; LIVE haiku extracts FK-denorm direction → not_a_decision=false subject mentions FK/denorm; commit-path runDecisionCapture w/ stub-extractor + stub-adapter dialogResponse=a → accepted_path canonical + ledger_size=1; reject-path → tombstone leaves DEC-id burned + allocator advances). ~1 cheap haiku call (~$0.03). |
| `da7e965` | 13 | Backprop protocol (Layer §V): `harness/src/backprop/` (types — BackpropInput w/ tightened_spec + acceptance + diff + failure_summary + run_id + in_scope_decision_ids + tier; BackpropOutput w/ slug + title + body_markdown + introduced_for_bug + enforcement{kind:regex_sensor\|named_e2e, regex, target_globs, language, failure_message, e2e_path}; BackpropResult w/ allocated id + invariant_path + sensor_path; schema — JSON Schema enforcing slug pattern + required fields for `--json-schema` gate; prompt — anti-tautology system: "extract the invariant *what*, not the bug; pick the cheapest enforcement that catches the regression class without false positives", emit-only-JSON, escape-hatch wildly-permissive regex when fix is cosmetic; id allocator — `allocateInvariantId` scans `.harness/ground/invariants/V*.md`, returns next monotonic V<NNNN> per L13.2; runner — `runBackprop` Tier 2 default (haiku in smokes), validates parsed BackpropOutput, mints id, writes V<N>.md + check-v<N>-<slug>.ts atomically; writer — `writeInvariantArtifacts` emits frontmatter (id/title/type:invariant/status:active/source_run/introduced_for_bug/sensor/naming_convention/source_decisions) + body w/ `## Enforcement` link to sensor; sensor template is a self-contained tsx walker w/ embedded REGEX/TARGET_GLOBS/LANGUAGE/FAILURE_MESSAGE constants — same SKIP_DIRS/glob-compile/lineOf primitives as Layer A; `named_e2e` writes `e2e/V<N>_<slug>.spec.ts` stub. Orchestrator wiring: `backpropping` phase added to RunPhase, `bypassBackprop` option, `backpropTier` override (default tier matches implementer); `runBackpropStep` runs after UAT pass, builds failure_summary from soft-sensor-findings + UAT-rejection-note + task-body, persists `runs/active/<run>/backprop/result.json`, commits invariant + sensor in mirror as `chore(invariants): add §V<N> from run <id>`. Existing `smoke:orchestrator` gets `bypassBackprop:true`. New `smoke:backprop` (5 steps — id allocator empty repo→V0001 + seeded V1+V7→V8 monotonic; LIVE haiku call on synthetic cross-tenant fix → asserts V0001 minted + invariant frontmatter shape + sensor generated; regenerated sensor exit 0 on clean tree; regenerated sensor exit 1 on regression tree w/ failure message; ~1 cheap haiku call ~$0.05). |
| `915f358` | 12 | GC cadence: `harness/src/gc/` (types — GcPass/GcFinding/GcCommitProposal/GcSweepResult/GcBatchResult/GcAutoMergeClass discriminator; `runFrontmatterFreshness` walks canonical zone, evaluates verified-at via existing `evaluateFreshness` w/ warn=30d/block=60d defaults, optional `forceRefresh:true` produces safe-class verified-at-bump proposals; `runGeneratorDrift` iterates `Profile.extractors`, regenerates output, emits safe-class regen-commit-proposal when on-disk content differs; `runStubCatalogHits` walks the FULL source tree (not just diff or canonical), runs the stub-pattern catalog regex against current content — Phase 12 v1 surfaces only, future revs add targeted-refactor proposals; `runDocGardening` extracts markdown links, surfaces broken-link findings + orphan markdowns not referenced by any other doc; `runQualityGradesUpdate` rebuilds `quality-grades.yaml` via existing `buildQualityGrades`, proposes safe-class write only when modules array changes (ignores generated-timestamp churn); `classifyAutoMerge` maps paths → safe|code|high-stakes per L16/L17/L18 — high-stakes globs dominate, code extension under source dominates over safe; `verifyBatchCanary` (per L46 must-fix) renders workflow.md against synthetic-task fixture and asserts every `{{var}}` resolves + required section headers present + manifest rebuild yields >0 entries — runs after multi-commit batches; `applyCommit` writes patch + git add + commit; `runGcSweep` composes all five passes, re-classifies via project globs; `runGcBatch` sweep → filter by applyClasses → applyCommit each → canary if applied≥2 → on canary fail `git reset --hard <pre_batch_sha>` rollback). CLI: `harness gc sweep|run` (`run --apply-classes safe[,code,high-stakes]` defaults safe-only; `--no-canary`, `--force-frontmatter-refresh`, `--json`). Ten-step `smoke:gc` (synthetic stale doc 90d → frontmatter pass surfaces block-severity finding, forceRefresh produces safe-class proposal, runGcBatch lands chore(gc) commit on main with verified-at bumped + body preserved, stub-catalog full-tree scan flags throw-not-implemented under .claude/skills, doc-gardening surfaces broken_link + orphan_path, quality-grades writes fresh yaml from terminal-runs fixture, classifier escalates high-stakes path correctly, multi-commit canary detects truncated workflow.md and rolls back to pre-batch SHA). PURE MECHANICAL — no claude burn. |
| `51916fb` | 11 complete | Phase 11 finishing pieces (11.x + 11.y + 11.5b): UAT-rejection-driven retry — `harness/src/uat/rejection.ts` (captureUatRejection runs A/B/C/D dialog via adapter.requestDialog after 🔴, optional voice URL detection + Whisper transcription via existing voice/transcribeUrl, writeRejectionYaml lands manifest under uat/, formatUatRejectionRemediation produces category-specific agent prompt); orchestrator dispatch loop now retries on operator-reject when attempts remain (cap = maxAttempts per L42), terminal-fails on probe-only fail or exhausted reject. Question flow — `harness/src/uat/question.ts` (read-only Tier-1 Haiku Q&A agent w/ structured output {answer, confidence_signal, citations}, NO file write tools); runUat extends ApprovalGate with optional questionText + cycles ❓ Ask up to maxQuestionRounds (default 5) calling questionHandler + notifier per round. Live pg + mysql drivers — `harness/src/uat/probes/sql/{pg,mysql}.ts` (lazy-loaded clients; READ-ONLY enforced by upstream regex gate AND defense-in-depth `BEGIN READ ONLY ... ROLLBACK` for pg / `SET SESSION TRANSACTION READ ONLY` for mysql; credentials only via env vars). setup-uat-sql gains `--install` (auto pnpm-add the matching driver pkg). Three new smokes: `smoke:uat-rejection` (6 mechanical cases — extractAudioUrl detection, captureUatRejection category=B w/ free text, invalid-choice fallback to D, writeRejectionYaml round-trip + parsed YAML check, formatUatRejectionRemediation includes operator note + failed AC + correct guidance, all 4 categories produce distinct guidance); `smoke:uat-question` (1 claude haiku call — agent answers concrete bundle question about AC failure, asserts answer references casing miss + at least one citation); both pure mechanical for rejection / 1 cheap haiku for question. |
| `f8f6121` | 11.5 | Heavy probes + setup helpers: live Playwright UI probe in `harness/src/uat/probes/ui.ts` (lazy-loaded `playwright-core`, launches chromium headless, runs UiStep[] script — goto/click/fill/screenshot/wait_for_selector/wait_for_text — captures per-step screenshots, video.webm, console.log, network.json under `runs/active/<id>/uat/probes/<probe_id>/`); live SQL probe split into `harness/src/uat/probes/sql/{types,config,sqlite,pg,mysql,index}.ts` (sqlite via lazy-loaded `better-sqlite3` is fully functional + READ-ONLY enforced + non-SELECT rejected; pg/mysql return Phase 11.5b placeholder errors; connection config from `.harness/config/probes/sql.yaml` with credentials only via env vars per operator preference); live integration probe in `harness/src/uat/probes/integration.ts` (docker-compose orchestration: `docker compose up -d <service>` → ready_check polling (http or cli, 60s deadline) → nested test probe (http or cli) → unconditional `docker compose down` teardown; SKIPS gracefully when docker compose not on PATH or compose file missing). Setup helpers: `setup:uat-browsers` wraps `npx playwright install chromium`; `setup:uat-sql --build-binding` writes `.harness/config/probes/sql.yaml` template + builds better-sqlite3 native binding using same path-with-spaces /tmp-staging trick as setup-whisper; `setup:uat-docker` sanity-checks docker compose + writes default compose template. devDependencies updated with `playwright-core@1.50.0` + `better-sqlite3@11.10.0` + `@types/better-sqlite3@7.6.13` (all heavy deps stay devDep so adopters install lean and opt in via setup helpers). smoke-uat updated: removed step 6 ui placeholder check (was env-fragile once playwright-core landed), added live UI probe step (visits in-process http page, captures 4 artifacts incl. video), added live SQL probe step (creates ephemeral sqlite db with 2 rows, asserts rowcount + first_row_includes), added SQL non-SELECT rejection step. |
| `bb8dd3f` | 11 | UAT-on-phone (Layer U) as multi-probe E2E framework: `harness/src/uat/` (types — discriminated union UatProbe over http/cli/ui/sql/integration, UatAcceptanceCheck routes ONE probe per AC, UatSummary canonical bundle, UatRunResult, UatRejection w/ A/B/C/D categories, EvidenceFile manifest; schema — JSON Schema for `--json-schema` gate; prompt — anti-hallucination "pick the cheapest probe that fits" ladder, http > cli > sql > ui > integration; runner — `generateUatChecks` Tier 2 default w/ defense-in-depth filter rejecting unavailable surfaces; probes/{http,cli}.ts — fetch + child_process w/ status/body/exit/stdout assertions, header_present, json_path_equals, body_matches_regex; probes/{ui,sql,integration}.ts — placeholder skipped_reason returns until Phase 11.5/11.6; probes/index.ts dispatches by `kind`; bundle — writeSummary, writeEvidenceFile (per-file SHA256 + bundle SHA256 manifest), verifyEvidenceFile rejecting bare-touch + post-hoc artifact mod + extra-file-after-evidence + non-approve decision; persistent — upsertUatTask under .harness/tasks/<task_id>/uat.md w/ status (pending|passing|passed|failed|blocked|abandoned), AC checklist, blocked_by NEVER folded into Gaps, gaps_resolved/gaps_open lists, attempt counter; uat — `runUat` full pipeline orchestrator: runner → cold-start smoke → probes → summary → UAT.md → adapter approval → evidence file). Orchestrator wired w/ `uat` phase after reviewer:ok, computes is_high_stakes from project_globs, approval gate maps adapter.requestApproval(ApprovalBundle) → UAT decision, RunMeta gets uat_history + last_uat. Phase 11 v1 fails-terminal on UAT failure (no retry); Phase 11.x adds rejection.yaml-driven retry. Existing smoke-orchestrator gets `bypassUat:true`. Two new smokes: `smoke:uat` 13 mechanical cases (http happy/fail, cross-tenant 403, cli pass/fail, ui/sql/integration → skipped, bundle write+verify, bare-touch reject, post-hoc-mod reject, extra-file reject, requireDecision reject, persistent UAT.md round-trip w/ gap resolution); `smoke:uat-runner` 3 claude scenarios (API spec → all http probes + backend_only=true; CLI spec → all cli probes; high-stakes spec → cross-tenant fixture flagged is_high_stakes_required=true). |
| `d29ccb3` | 10 | reviewer subagent (Layer C): `harness/src/reviewer/` (types — ReviewVerdict, ReviewGapCategory w/ 10 kinds incl `deferred_but_claimed_done` + `query_scope_omission` + `decision_contradiction`, ReviewerInput/Output/Result; schema — JSON Schema for `--json-schema` gate w/ verdict/gaps/confidence_signal/summary; prompt — anti-completionist system prompt (default-fail framing, "prove the implementer wrong"), buildReviewerUserPrompt assembles tightened spec + acceptance + decisions-in-scope + soft-findings + diff content (32k cap per file) + high-stakes augmentation per Codex audit Q1; reviewer — `runReviewer` Tier-matched-to-implementer per L15, validates parsed structured_output, computes ok = verdict:pass AND zero hard gaps; remediation — `formatReviewerRemediation` agent-prompt-shaped retry context; index). Orchestrator wired w/ `reviewing` phase after sensors:ok, runs reviewer w/ `runReviewerStep` (re-computes diff + decisions + high-stakes flag from project_globs), persists `reviewer/attempt-N.json`, RunMeta gets `reviewer_history` + `last_reviewer`, on verdict:fail w/ attempts left appends remediation + retries, exhaustion → fail-honesty-check. Existing smoke-orchestrator gets `bypassReviewer:true`. New `smoke:reviewer` (clean diff → verdict:pass; deferred-but-claimed-done diff → verdict:fail w/ hard gaps citing tax/discount/deferred miss; ~2 cheap haiku calls, ~$0.05 quota) |
| `9223ef0` | 9 | sensor runners + Layer A/B/D + decision-assertions: `harness/src/sensors/` (types, `getDiff` via simple-git tracked+untracked, `loadStubCatalog`/`loadSensorRegistry` with project→pkg fallback, Layer A `runStubCatalog` flagging only added lines, Layer B `runAttestationCrossCheck` extracting fenced YAML + cross-checking files_touched/todos/stubs/behavior:full lies, Layer D `runRouteHandlerNonEmpty`+`runDtoNoFakeFields` glob-scoped structural sensors, `runDecisionAssertions` evaluating all 11 assertion kinds w/ regex approximations for ast/query/event/service kinds, `formatRemediation` agent-prompt-shaped failure formatter, `runSensors` orchestrator entry); orchestrator wired w/ retry loop (max_attempts=3 per L42), `sensing` phase, `sensor_history`/`last_sensor_sweep` on RunMeta, `attempt-N.json` persisted per run; `smoke:sensors` (16 unit + integration cases, no claude burn); existing `smoke:orchestrator` set `bypassSensors: true` since Phase 8 template predates attestation contract |
| `6c945fa` | 8 | orchestrator + agent runner: `harness/src/orchestrator/` (inbox tailer w/ chokidar, FIFO + persisted shadow, workspace prep w/ syncMirror + SHA pin + dirty-overlap gate per L45, prompt renderer for `workflow.md`, agent runner via `claude --print --output-format stream-json`, `Orchestrator` class), `harness run` CLI starts it by default; `smoke:orchestrator` (drop task → run → assert echo.txt + events.jsonl + no commit); default `--permission-mode bypassPermissions` per operator preference |
| `b730bac` | 7 | spec tightener (Layer F): `harness/src/claude/` subprocess wrapper (`claude --print --model <tier> --output-format json --json-schema ...`); `harness/src/tightener/` (Tier-1 Haiku default, Sonnet auto-escalate >500 words or via `force_tier`, structured JSON output, `ship_anyway` override); `smoke:tightener`; `.env.example` cleaned of `ANTHROPIC_API_KEY` (subscription auth only) |
| `cdd0f13` | 6 | Whisper voice ingress (smart-whisper + ffmpeg pipe, audio never on disk) + Tier-0 Ollama classifier (llama3.2:3b, regex fallback), Discord adapter wired to both, `setup:whisper` build helper for path-with-spaces node-gyp workaround, `smoke:whisper` + `smoke:tier0` |
| `b5c7420` | 5 | Discord ingress: frontend-adapter contract, Discord adapter (slash + categories + buttons + ACL + regex Tier-0 stub), stub adapter, `harness run --frontend <name> --project <slug>` CLI, `smoke:discord` |
| `c665fce` | 4 | harness-mcp server (17 tools, stdio transport) |
| `96b2fa7` | 3 | grounding daemon (chokidar + manifest + ledgers + drift + quality grades + profile registry) |
| `ce30537` | 2 | mirror checkout runtime (clone/sync/push/dirty-overlap; `~/.local/harness/repos/<slug>/`) |
| `d011463` | 0–1 | bootstrap pkg + design docs + canonical templates under `harness/templates/` |

### Twenty sensors green (smoke:decision-capture added — ~1 cheap haiku call; smoke:backprop + smoke:gc + smoke:sensors pure mechanical-or-cheap)

```
pnpm -F @devplusllc/harness build              # tsc -b
pnpm -F @devplusllc/harness typecheck          # tsc -b --noEmit
pnpm -F @devplusllc/harness check:layout       # validates pkg+templates + scans for banned project names
pnpm -F @devplusllc/harness smoke:mirror       # ephemeral bare-origin + user-tree round-trip
pnpm -F @devplusllc/harness smoke:watch        # daemon programmatic; manifest + decisions ledger update on file events
pnpm -F @devplusllc/harness smoke:mcp          # InMemoryTransport client/server; all 17 tools exercised
pnpm -F @devplusllc/harness smoke:discord      # stub-adapter contract: ingest events → inbox JSON; outbound calls recorded
pnpm -F @devplusllc/harness smoke:tier0        # regex fallback always; Ollama path runs when available, otherwise SKIPS
pnpm -F @devplusllc/harness smoke:whisper      # macOS `say` clip → ffmpeg → smart-whisper; SKIPS on non-darwin/missing model/missing binding
pnpm -F @devplusllc/harness smoke:tightener    # vague→blocked, clear→sonnet judgment, ship_anyway→forced; SKIPS without `claude` CLI auth
pnpm -F @devplusllc/harness smoke:orchestrator # ephemeral mirror + drop task → orchestrator picks up → claude implementer writes file in mirror → assert echo.txt + events.jsonl + no commit
pnpm -F @devplusllc/harness smoke:sensors      # 16 cases — Layer A clean/dirty + line-add discrimination, Layer B missing/accurate/lying attestation, Layer D route-handler-non-empty + dto-no-fake-fields, decision-assertions text_must_match + file_must_not_be_modified via ephemeral git mirror; PURE MECHANICAL — no claude burn
pnpm -F @devplusllc/harness smoke:reviewer     # 2 cases — clean diff → verdict:pass; deferred-but-claimed-done diff → verdict:fail w/ hard gaps citing the deferral. SKIPS without `claude` CLI auth
pnpm -F @devplusllc/harness smoke:uat          # 16 cases — http/cli probes pass/fail, sql/integration → skipped when surface missing, bundle write+verify, bare-touch reject, post-hoc-mod reject, extra-file-after-evidence reject, requireDecision reject, persistent UAT.md round-trip + gap resolution, LIVE UI probe (skips if playwright-core/chromium missing), LIVE SQL probe (skips if better-sqlite3 missing), SQL probe rejects non-SELECT. No claude burn; live probes need devDeps installed (`pnpm install` + `pnpm -F @devplusllc/harness setup:uat-browsers && setup:uat-sql --build-binding`)
pnpm -F @devplusllc/harness smoke:uat-runner   # 3 cases — API spec → http; CLI spec → cli; high-stakes spec → cross-tenant fixture flagged. SKIPS without `claude`
pnpm -F @devplusllc/harness smoke:uat-rejection # 6 cases — extractAudioUrl detection, captureUatRejection w/ stub adapter A/B/C/D, invalid-choice fallback, writeRejectionYaml round-trip, remediation formatter shape, category-specific guidance differs. PURE MECHANICAL — no claude burn
pnpm -F @devplusllc/harness smoke:uat-question  # 1 case — question agent answers concrete bundle question, asserts citations + casing-miss reference. ~1 cheap haiku call. SKIPS without `claude`
pnpm -F @devplusllc/harness smoke:gc            # 10 cases — frontmatter-stale 90d surfaced, forceRefresh proposal, runGcBatch lands safe-class commit on main with body preserved, stub-catalog full-tree scan flags throw-not-implemented, doc-gardening broken_link+orphan_path, quality-grades fresh-yaml proposal, classifier safe|code|high-stakes precedence, multi-commit canary rollback on truncated workflow.md. PURE MECHANICAL — no claude burn.
pnpm -F @devplusllc/harness smoke:backprop      # 5 steps — id allocator empty→V0001, seeded V1+V7→V8 monotonic; LIVE haiku call on synthetic cross-tenant fix mints invariant + emits regex sensor; regenerated sensor exit 0 on clean tree, exit 1 on regression. ~1 cheap haiku call ~$0.05. SKIPS without `claude`.
pnpm -F @devplusllc/harness smoke:decision-capture # 6 steps — id allocator empty→DEC-0001 + advances past existing accepted+draft → DEC-0006; writeDecisionDraft frontmatter passes parse w/ status:draft; acceptDraft flips status, moves to canonical, ledger regenerates incl. DEC-0006; LIVE haiku extracts "FK denorm only" direction (not_a_decision=false, subject mentions FK/denorm); end-to-end commit path lands accepted_path; reject path leaves `.rejected.md` tombstone so DEC-id is monotonically burned. ~1 cheap haiku call (~$0.03). SKIPS Step 4 only without `claude`.
```

Run all sixteen cheap ones before doing anything that mutates `harness/src/` or `harness/templates/`. The tightener, reviewer, uat-runner, orchestrator, and backprop smokes each cost ~1-3 `claude` calls; budget ~$1 of subscription quota for the full sweep, skip casually for unrelated touches.

The Discord adapter is real code (`harness/src/frontend/discord/`); it is not exercised in CI/smoke because live exercise needs `DISCORD_BOT_TOKEN`. Live wiring confirmed against guild `1487133145013944443` during Phase 5 acceptance: bot connects, 13 slash commands register, the three category channels (`📋 backlog`, `🟢 active`, `📦 archive`) are ensured.

### One-time setup steps (operator)

`smart-whisper` ships a node-gyp-built native binding. node-gyp's generated Makefile does not properly quote `module_root_dir`, so on macOS where the project commonly lives at a path with spaces, the build fails. After `pnpm install`, run:

```
pnpm -F @devplusllc/harness setup:whisper
```

This stages the package in `/tmp/harness-sw-*`, builds there, and copies `build/Release/smart-whisper.node` back into the resolved `node_modules` location. Idempotent (no-op when binding exists; `--force` rebuilds). Phase 16 init script will run this automatically on adoption.

`ffmpeg`, `whisper-cpp` (brew), and Ollama (with `llama3.2:3b` pulled) are also required for Phase 6 features:

```
brew install ffmpeg whisper-cpp ollama
ollama pull llama3.2:3b
mkdir -p ~/.local/harness/models && curl -L -o ~/.local/harness/models/ggml-large-v3-turbo-q5_0.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin?download=true"
```

### Source tree

```
harness/
├── package.json         @devplusllc/harness@0.0.0; deps: discord.js v14, smart-whisper,
│                        chokidar, simple-git, fastify, pino, dotenv, zod, ws, yaml,
│                        @modelcontextprotocol/sdk
├── tsconfig.json        extends ../tsconfig.base.json (strict, NodeNext ESM, composite)
├── .env.example         secrets only (DISCORD_BOT_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY,
│                        OLLAMA_HOST=http://localhost:11434)
├── README.md
├── src/
│   ├── index.ts         export const VERSION = "0.0.0"
│   ├── logger.ts        pino with secret-redaction; `logger(module)` factory
│   ├── cli/
│   │   ├── index.ts     dispatch: watch | run | init | mirror | mcp | --version
│   │   ├── watch.ts     `harness watch --project <slug>` long-lived
│   │   ├── mirror.ts    `harness mirror init|sync|push|status`
│   │   ├── mcp.ts       `harness mcp serve [--repo-root <path>]`
│   │   └── run.ts       `harness run --project <slug> [--frontend <name[,name...]>]`
│   │                    Phase 5 — brings up registered frontend adapters and
│   │                    idles. Orchestrator (Phase 8) consumes inbox rows.
│   ├── mirror/          paths, state (zod-validated mirror.json), clone, sync,
│   │                    push, dirty-overlap (L45 gate), types, index
│   ├── ground/          schemas (Provenance, Manifest, DecisionFrontmatter w/ 11
│   │                    assertion kinds, InvariantFrontmatter, ledger entries,
│   │                    QualityGrade, DriftEvent), paths, glob (native ** / *
│   │                    matcher), walk, frontmatter parser + freshness, manifest
│   │                    builder, ledgers, drift, quality-grades, index
│   ├── profiles/        Profile interface + extractors as extension points;
│   │                    unknown.ts is the fallback profile (always detects, no
│   │                    extractors); registry; index. Future profiles
│   │                    (typescript-next-nest, python-fastapi, rails, go, rust)
│   │                    register before unknown.
│   ├── watch/           regenerateAll (idempotent; manifest + ledgers + quality +
│   │                    profile extractors); chokidar daemon (debounced 500 ms,
│   │                    coalesces in-flight regens); PID file at
│   │                    ~/.local/harness/state/<project>/watch.pid
│   ├── mcp/             server (McpServer + StdioServerTransport, telemetry +
│   │                    timing wrapper around every handler), context, errors
│   │                    (McpErrorCode union + envelope), result (asMcpResult),
│   │                    path-allowlist (APPEND_ALLOWLIST, ARCHIVE_DENY,
│   │                    HISTORICAL_ZONE), telemetry (per-call jsonl), schemas
│   │                    (zod input shapes per tool), tools/{17 handlers}/*.ts
│   ├── frontend/        adapter contract (types.ts: FrontendAdapter,
│   │                    FrontendTask/VoiceMessage/SlashEvent/FreeTextEvent/
│   │                    InteractionEvent/DialogSpec/ApprovalBundle), inbox.ts
│   │                    helper (writes `.harness/inbox/<ts>-<source>-<kind>-
│   │                    <slug>.json`), stub/ in-memory adapter for tests,
│   │                    discord/ real adapter (acl, slash command builders,
│   │                    channels lifecycle, index DiscordFrontendAdapter
│   │                    wired to voice + tier0)
│   ├── voice/           types, model (singleton Whisper, lazy load), pipe
│   │                    (ffmpeg subprocess: arbitrary audio Buffer → 16k
│   │                    mono Float32 PCM, never disk), transcribe (entry
│   │                    points: transcribeBuffer + transcribeUrl), index
│   ├── tier0/           types (Tier0Intent, ClassificationResult), ollama
│   │                    (minimal HTTP client + isAvailable + hasModel),
│   │                    classify (Ollama-first with llama3.2:3b, regex
│   │                    fallback when unreachable), index
│   ├── claude/          subprocess wrapper for the `claude` CLI: types
│   │                    (ClaudeTier, RunClaudeOptions/Result), runner
│   │                    (`claude --print --model <tier> --output-format
│   │                    json --json-schema ...` over stdin; reads
│   │                    structured_output from envelope), index. The
│   │                    only place that knows about the CLI; everything
│   │                    else calls `runClaude`.
│   ├── tightener/       Layer F spec tightener: types (TightenerInput/
│   │                    Output/Result), schema (JSON Schema for the
│   │                    --json-schema gate), prompt (system + user prompt
│   │                    builders), tighten (`tightenSpec(input)` — Tier-1
│   │                    Haiku default, Sonnet auto-escalate on >500 word
│   │                    bodies or `force_tier`, ship_anyway override),
│   │                    index
│   ├── orchestrator/    Phase 8 FIFO + agent runner. types (RunPhase incl
│   │                    `sensing` + `reviewing` + `uat`, RunMeta w/ attempts +
│   │                    sensor_history + last_sensor_sweep + reviewer_history
│   │                    + last_reviewer + uat_history + last_uat, InboxTaskRow,
│   │                    OrchestratorOptions w/ bypassSensors + bypassReviewer +
│   │                    bypassUat + uatHints + uatColdStartCommand +
│   │                    sensorLanguages + projectGlobs + maxAttempts,
│   │                    QueueEntry); inbox (tail .harness/inbox/<...>.json,
│   │                    move to processed/<...>.<outcome>.json after
│   │                    completion); queue (in-memory FIFO + YAML shadow
│   │                    at .harness/tasks/active/_queue.yaml; cap = 1);
│   │                    workspace (syncMirror → SHA pin → dirty-overlap
│   │                    gate per L45); prompt (minimal Liquid-style
│   │                    templater for `workflow.md` placeholders); runner
│   │                    (`runImplementer` spawns `claude --print
│   │                    --output-format stream-json
│   │                    --include-partial-messages
│   │                    --permission-mode bypassPermissions --add-dir
│   │                    <mirror>`, line-by-line stream parse,
│   │                    events.jsonl); orchestrator (chokidar + poll loop,
│   │                    single-task dispatcher, retry loop max_attempts
│   │                    per L42 with remediation-prompt feedback —
│   │                    sensor remediation OR reviewer remediation —
│   │                    persists `sensors/attempt-N.json` +
│   │                    `reviewer/attempt-N.json`, surfaces phase
│   │                    transitions to adapters via postTaskUpdate)
│   ├── sensors/         Phase 9 honest-agent invariants stack (Layer A/B/D
│                        + decision-assertions). types (DiffEntry,
│                        Attestation, SensorFinding, SensorResult,
│                        SensorSweepResult, ProjectGlobs, StubCatalog);
│                        diff (`getDiff(mirrorPath, shaPin)` via simple-git,
│                        tracked + untracked); catalog (loadStubCatalog +
│                        loadSensorRegistry with project→pkg fallback);
│                        stub-catalog (Layer A — flags only ADDED lines,
│                        line-aware diff against beforeContent, language-
│                        filtered patterns); attestation (Layer B —
│                        extracts fenced YAML, cross-checks files_touched
│                        set-equality, todos_introduced count, hard-stub
│                        count, behavior:full + stub coexistence lies);
│                        structural (Layer D — runRouteHandlerNonEmpty
│                        glob-scoped to route_handler_globs w/ NestJS+
│                        FastAPI hint, runDtoNoFakeFields glob-scoped to
│                        dto_globs flagging bare @IsOptional()); decisions
│                        (loadAcceptedDecisions, decisionsInScope,
│                        listMirrorFiles via `git ls-files`, runDecisionAssertions
│                        evaluating all 11 kinds — schema_must_contain via
│                        ±10-line co-location, text_must_(not_)match,
│                        index_must_exist via CREATE INDEX regex with optional
│                        WHERE, ast_pattern as regex fallback,
│                        file_must_not_be_modified, query_must_filter_by
│                        via .where()-window column scan, route_must_have_guard
│                        via 8-line preceding window, event_must_emit via
│                        co-occurrence, service_method_must_call via method-
│                        body-block scan, human_review_hint as soft);
│                        remediation (formatRemediation — agent-prompt-shaped
│                        failure body w/ concrete path:line + matched_text +
│                        retry-attempt-of-N header); runner (`runSensors`
│                        composes Layer A + B + D + decisions, returns
│   │                    SensorSweepResult w/ ok + remediation_prompt);
│   │                    index
│   ├── reviewer/        Phase 10 Layer C — fresh-context reviewer
│   │                    subagent. types (ReviewVerdict, ReviewGapCategory
│   │                    w/ 10 kinds, ReviewerInput/Output/Result); schema
│   │                    (JSON Schema for `--json-schema` gate); prompt
│   │                    (anti-completionist system: default-fail, "prove
│   │                    the implementer wrong"; buildReviewerUserPrompt
│   │                    — tightened spec + acceptance + decisions-in-scope
│   │                    w/ assertion summary + soft sensor findings + diff
│   │                    content per file (32k char cap) + high-stakes
│   │                    query-scope completeness augmentation per Codex
│   │                    audit Q1); reviewer (`runReviewer` Tier-matched-
│   │                    to-implementer per L15, validates structured_output,
│   │                    ok = verdict:pass AND zero hard gaps); remediation
│   │                    (`formatReviewerRemediation` agent-prompt-shaped
│   │                    retry context naming each hard gap by category +
│   │                    path + symbol); index
│   ├── uat/             Phase 11/11.5 Layer U — multi-probe E2E framework.
│                        types (discriminated union UatProbe over
│                        http/cli/ui/sql/integration, UatAcceptanceCheck
│                        routes ONE probe per AC, UatSummary, UatRunResult,
│                        UatRejection w/ A/B/C/D categories, EvidenceFile
│                        manifest); schema; prompt (anti-hallucination
│                        "pick the cheapest probe that fits" ladder
│                        http > cli > sql > ui > integration — never open
│                        a browser to test an API call; high-stakes
│                        cross-tenant fixture mandate); runner
│                        (`generateUatChecks` Tier 2 default; defense-
│                        in-depth filter rejects probes for unavailable
│                        surfaces); probes/{http,cli,ui,sql,integration,
│                        index}.ts (http: fetch w/ status/body/json-path/
│                        header assertions; cli: child_process w/ exit/
│                        stdout/stderr; ui: lazy-loaded playwright stub
│                        returning skipped_reason until Phase 11.5; sql/
│                        integration: skipped_reason placeholders for
│                        Phase 11.6); bundle (writeSummary canonical YAML,
│                        writeEvidenceFile per-file SHA256 + bundle
│                        SHA256 manifest at .uat-passed, verifyEvidenceFile
│                        rejecting bare-touch / post-hoc-mod / extra-file
│                        / non-approve); persistent (upsertUatTask under
│                        .harness/tasks/<task_id>/uat.md per GSD pattern,
│                        status pending|passing|passed|failed|blocked|
│                        abandoned, blocked_by NEVER folded into Gaps);
│                        uat (`runUat` full pipeline: runner → cold-start
│                        smoke → probes → summary → UAT.md → adapter
│                        approval → evidence file). Index
│   ├── gc/              Phase 12 garbage-collection cadence. types
│                        (GcPass, GcFinding, GcCommitProposal,
│                        GcSweepResult, GcBatchResult, GcAutoMergeClass,
│                        CanarySyntheticContext); frontmatter
│                        (`runFrontmatterFreshness` walk canonical →
│                        `evaluateFreshness` warn=30d/block=60d, optional
│                        forceRefresh produces safe-class verified-at-bump
│                        proposal preserving body); generator-drift
│                        (`runGeneratorDrift` iterates Profile.extractors,
│                        regenerates output, safe-class proposal when
│                        on-disk differs); stub-hits (`runStubCatalogHits`
│                        full-tree walk skipping .git/node_modules/dist/
│                        .archive, language-filtered regex, surface-only
│                        v1); doc-gardening (`runDocGardening` extracts
│                        markdown link tuples, surfaces broken_link +
│                        orphan_path findings — orientation files always
│                        excluded from orphan check); quality-update
│                        (`runQualityGradesUpdate` rebuilds grades via
│                        existing buildQualityGrades, proposes safe-class
│                        write only when modules array changes — ignores
│                        generated-timestamp churn); classify
│                        (`classifyAutoMerge` paths→safe|code|high-stakes
│                        — high-stakes globs dominate; .ts/.py/etc outside
│                        safe-prefixes escalates to code; docs/.harness/
│                        ground/.archive/.claude/ all safe by default);
│                        canary (`verifyBatchCanary` per L46 — render
│                        workflow.md against synthetic fixture, assert
│                        every {{var}} resolves + required section
│                        headers present, manifest rebuild non-empty;
│                        `buildSyntheticContext` ships a minimal known-
│                        good fixture); apply (`applyCommit` writes
│                        patch + git add + commit, returns SHA);
│                        sweep (`runGcSweep` composes all five passes
│                        sequentially, re-classifies via project globs;
│                        `runGcBatch` sweep → filter by applyClasses →
│                        applyCommit each → if applied≥2 run canary →
│                        on canary fail `git reset --hard <pre_batch_sha>`
│                        rollback). Index
│   ├── backprop/        Phase 13 backprop protocol (Layer §V).
│                        types (BackpropInput w/ tightened_spec +
│                        acceptance + diff + failure_summary + run_id +
│                        in_scope_decision_ids + tier; BackpropOutput w/
│                        slug + title + body_markdown + introduced_for_bug
│                        + enforcement{kind,regex,target_globs,language,
│                        failure_message,e2e_path}; BackpropResult w/
│                        allocated id + invariant_path + sensor_path);
│                        schema (JSON Schema for `--json-schema` gate
│                        enforcing slug pattern + required fields); prompt
│                        (anti-tautology system: "extract the *what*, not
│                        the bug; pick the cheapest enforcement that
│                        catches the regression class without false
│                        positives", emit-only-JSON, escape-hatch
│                        permissive regex when fix is cosmetic;
│                        buildBackpropUserPrompt assembles tightened spec +
│                        AC + failure_summary + diff with 16k char per-file
│                        cap); id (`allocateInvariantId` scans
│                        .harness/ground/invariants/V*.md, returns next
│                        monotonic V<NNNN> per L13.2); writer
│                        (`writeInvariantArtifacts` mints frontmatter —
│                        id/title/type:invariant/status:active/source_run/
│                        introduced_for_bug/sensor/naming_convention/
│                        source_decisions — and body w/ `## Enforcement`
│                        link; sensor template is self-contained tsx
│                        walker w/ embedded REGEX/TARGET_GLOBS/LANGUAGE/
│                        FAILURE_MESSAGE constants and same SKIP_DIRS/
│                        glob-compile/lineOf primitives as Layer A;
│                        `named_e2e` writes e2e/V<N>_<slug>.spec.ts stub);
│                        runner (`runBackprop` Tier 2 default, validates
│                        parsed BackpropOutput shape, mints id, writes
│                        invariant + sensor atomically). Index
│   └── decision-capture/ Phase 14 decision capture flow.
│                        types (DecisionExtractorInput/Output, CandidateAssertion
│                        loose, DecisionDraft, DraftConfirmDecision = commit |
│                        edit | reject, ConfirmResult, DecisionCaptureResult);
│                        schema (JSON Schema for `--json-schema` gate enforcing
│                        required fields + assertion-kind enum + maxItems:3);
│                        prompt (anti-fabrication system: "extract the *what*,
│                        not the bug; not_a_decision=true for rambling/off-
│                        topic/questions; supersedes only when input EXPLICITLY
│                        revokes a prior decision"; emit-only-JSON; passes
│                        accepted_decisions context for supersedes detection);
│                        id (`allocateDecisionId` scans
│                        .harness/ground/decisions/{,_inbox/}*.md for highest
│                        existing DEC-NNNN incl. drafts AND `.rejected.md`
│                        tombstones, returns next monotonic id per L13.2);
│                        extractor (`runDecisionExtractor` Tier 1 default per
│                        workflow.md `decision_extractor: 1`, validates parsed
│                        output via isOutput guard); writer (`writeDecisionDraft`
│                        emits frontmatter — id/title/type:adr/status:draft/
│                        decided_at/decided_by/scope_globs/supersedes/
│                        capture_source/capture_confidence — and body w/
│                        Summary/Original direction/Scope/Candidate assertions
│                        sections; CRITICAL: candidate_assertions go under
│                        FRONTMATTER `candidate_assertions:` field NOT strict
│                        `assertions:` so DecisionFrontmatter zod doesn't
│                        reject the draft — assertions get lifted only after
│                        Phase 14.x refinement; `acceptDraft` flips status:
│                        draft→accepted, moves to canonical, regenerates
│                        decisions.ledger.yaml, stamps `superseded_by` on
│                        prior decision when set; `rejectDraft` writes
│                        `.rejected.md` tombstone NOT delete so DEC-id is
│                        monotonically burned); capture (`runDecisionCapture`
│                        orchestrates extract → if not_a_decision short-circuit
│                        → write draft → adapter.requestDialog 🟢/🟡/🔴/E) →
│                        accept/edit/reject branch; on dialog timeout treat
│                        as edit so draft survives for return-trip;
│                        `extractorOverride` injection point for smokes that
│                        skip the LLM call). Index
├── scripts/
│   ├── check-layout.ts  Phase 1 sensor — also scans pkg/templates for banned
│   │                    "mypal" strings (project-agnostic check per L50, S1)
│   ├── setup-mirror.ts  adoption helper: detects origin from cwd, derives slug
│   │                    from package.json `name`, calls ensureMirror
│   ├── smoke-mirror.ts  Phase 2 acceptance
│   ├── smoke-watch.ts   Phase 3 acceptance
│   ├── smoke-mcp.ts     Phase 4 acceptance
│   ├── smoke-discord.ts Phase 5 acceptance (stub adapter; live wiring needs
│   │                    DISCORD_BOT_TOKEN)
│   ├── smoke-whisper.ts Phase 6 acceptance (macOS `say`-synthesized clip →
│   │                    transcribe; SKIPS on non-darwin/missing binding/
│   │                    missing model)
│   ├── smoke-tier0.ts   Phase 6 acceptance (regex fallback always; Ollama
│   │                    path SKIPS when daemon unreachable)
│   ├── smoke-tightener.ts Phase 7 acceptance: vague→blocked, clear→Sonnet
│   │                    judgment (ambiguities differentiate), ship_anyway
│   │                    forces release. Burns ~3 claude calls.
│   ├── smoke-orchestrator.ts Phase 8 acceptance: ephemeral mirror, drop
│   │                    task, agent writes echo.txt, assert events.jsonl
│   │                    populated + no commit landed. Burns ~1 claude
│   │                    haiku call. Sets `bypassSensors: true` since the
│   │                    Phase 8 inline template predates attestation
│   │                    contract (Phase 9 contract lives in templates/
│   │                    .harness/config/workflow.md).
│   ├── smoke-sensors.ts Phase 9 acceptance: 16 cases — Layer A clean
│   │                    pass, throw-not-implemented hard fail, line-add
│   │                    discrimination (pre-existing stub doesn't fail),
│   │                    Layer B missing-attestation hard fail, accurate-
│   │                    attestation pass, files_touched mismatch fail,
│   │                    behavior:full + stub-coexistence lie, Layer D
│   │                    empty controller fail + non-empty pass, dto bare
│   │                    @IsOptional() soft, decision-assertions
│   │                    text_must_match miss + file_must_not_be_modified
│   │                    violation via ephemeral git mirror,
│   │                    parseStubCatalog malformed-entry skip. PURE
│   │                    MECHANICAL — no claude burn.
│   ├── smoke-reviewer.ts Phase 10 acceptance: clean implementation of a
│   │                    `sum` function → reviewer verdict:pass, zero hard
│   │                    gaps; deferred-but-claimed-done `calculateTotal`
│   │                    (TODO comment + skipped tax/discount logic) →
│   │                    verdict:fail w/ hard gaps citing the
│   │                    deferred_but_claimed_done category. ~2 cheap
│   │                    haiku calls (~$0.05). SKIPS without `claude`.
│   ├── smoke-uat.ts     Phase 11 mechanical acceptance: in-process http
│   │                    server hit by http probe (200/403/json-path);
│   │                    cli probe via `node --version` + exit-code
│   │                    mismatch; ui/sql/integration return structured
│   │                    skipped_reason; bundle write + evidence-file
│   │                    SHA256 round-trip; bare-touch detection;
│   │                    post-hoc artifact mod detection; extra-file-
│   │                    after-evidence detection; requireDecision
│   │                    rejection on pending; persistent UAT.md round-
│   │                    trip incl. gap-add + gap-resolve flow. PURE
│   │                    MECHANICAL — no claude burn.
│   ├── smoke-uat-runner.ts Phase 11 UAT-runner agent acceptance:
│   │                    API spec → all probes are http + backend_only=
│   │                    true; CLI spec → all probes are cli; high-stakes
│   │                    spec → at least one is_high_stakes_required=true
│   │                    cross-tenant fixture (http probe). ~3 cheap
│   │                    haiku calls. SKIPS without `claude`.
│   ├── setup-uat-browsers.ts Phase 11.5 — `npx playwright install
│   │                    chromium`. Idempotent. `--with-deps` for Linux
│   │                    system libs.
│   ├── setup-uat-sql.ts Phase 11.5 — writes default
│   │                    .harness/config/probes/sql.yaml (sqlite by
│   │                    default; --driver postgres|mysql produces
│   │                    template for Phase 11.5b runtime). With
│   │                    --build-binding: builds better-sqlite3 native
│   │                    binding using same /tmp-staging trick as
│   │                    setup-whisper to dodge node-gyp's path-with-
│   │                    spaces failure. Idempotent.
│   ├── setup-uat-docker.ts Phase 11.5 — sanity-checks `docker compose
│   │                    --version` + writes default
│   │                    .harness/config/probes/docker-compose.yml
│   │                    template. Idempotent.
│   ├── setup-whisper.ts one-time native binding build helper (works around
│   │                    node-gyp + path-with-spaces failure)
│   ├── smoke-gc.ts      Phase 12 acceptance: 10 cases — synthetic stale
│                        doc 90d → frontmatter pass surfaces block-
│                        severity finding, forceRefresh produces safe-
│                        class proposal, runGcBatch lands chore(gc)
│                        commit on main with verified-at bumped + body
│                        preserved, stub-catalog full-tree scan flags
│                        throw-not-implemented under .claude/skills,
│                        doc-gardening surfaces broken_link +
│                        orphan_path, quality-grades writes fresh yaml
│                        from terminal-runs fixture, classifier
│                        escalates high-stakes path correctly, multi-
│                        commit canary detects truncated workflow.md
│                        and rolls back to pre-batch SHA. PURE
│                        MECHANICAL — no claude burn.
│   ├── smoke-backprop.ts Phase 13 acceptance: 5 steps — id allocator
│                        empty repo→V0001, seeded V1+V7→V8 monotonic;
│                        LIVE haiku call on synthetic cross-tenant fix
│                        (findTokenByProvider missing user_id) mints
│                        invariant V0001 + emits regex sensor; the
│                        regenerated sensor returns exit 0 on a tree
│                        containing the FIXED code, exit 1 on a tree
│                        containing the regression. Sensor-quality
│                        warnings (overly-aggressive or overly-permissive
│                        regex) downgrade to OK-with-warning so harness
│                        infra is verified independent of LLM judgment.
│                        ~1 cheap haiku call (~$0.05). SKIPS without
│                        `claude`.
│   └── smoke-decision-capture.ts Phase 14 acceptance: 6 steps —
│                        allocateDecisionId on empty repo→DEC-0001 +
│                        advances past existing DEC-0003 + draft
│                        DEC-0005 → DEC-0006; writeDecisionDraft
│                        emits valid frontmatter w/ status:draft;
│                        acceptDraft flips status, moves to
│                        canonical, ledger contains DEC-0006 entry;
│                        LIVE haiku extractor on "scrap that — FK
│                        denorm only" direction returns
│                        not_a_decision=false w/ subject mentioning
│                        FK/denorm; runDecisionCapture commit path
│                        w/ stub-adapter dialogResponse=a leaves
│                        accepted_path canonical + ledger_size=1;
│                        reject path w/ dialogResponse=c leaves
│                        `.rejected.md` tombstone so allocator
│                        advances to DEC-0002 (no recycle). Steps 1/2/
│                        3/5/6 pure mechanical; Step 4 ~1 haiku call
│                        (~$0.03). Step 4 only SKIPS without `claude`.
└── templates/           seed copied into adopting projects by `harness init`
    ├── README.md
    ├── .harness/
    │   ├── config/{workflow.md, sensors.yaml, stub-patterns.yaml,
    │   │           trust-policy.yaml}
    │   └── ground/{manifest.yaml stub, canonical-map/topics.yaml stub}
    └── .archive/README.md
```

### Implementation invariants (binding)

- **Project-agnostic pkg code.** No `mypal` / `Mypal` / `MYPAL` strings anywhere under `harness/src/`, `harness/scripts/`, or `harness/templates/`. The `check-layout` sensor enforces this. The `<project_name>:` placeholder in `templates/.harness/config/workflow.md` is replaced by the init script with the adopting project's name.
- **`.harness/` lives in adopted projects, not in this repo.** Do not create `.harness/` or `.archive/` at the Harness repo root. Templates ship under `harness/templates/`.
- **Mirror is harness's only writable git state.** Reads against the user's working tree are allowed (dirty-overlap check); writes are not.
- **MCP tools never throw.** They return either a success payload or `{ error: { code, message, details? } }`. The smoke test asserts both shapes.
- **`harness_query_history` returns `NOT_IMPLEMENTED`.** Real impl awaits Tier-1 LLM integration (Phase 5+); the error envelope is the safe default.
- **No tests.** Operator's stance: sensors and E2E real-DB only. Smoke scripts under `scripts/smoke-*.ts` are the acceptance gates per phase.

### What's NOT yet wired

Phases 15–18 from `docs/INTEGRATION_PLAN.md`. In particular:

- **No trial-run pilot.** Phase 15 — exercise full lifecycle on a real backlog item from an adopted project (mypal). Voice variant + decision-capture variant per spec.
- **No GC cron schedule.** `harness gc sweep|run` exists as a CLI; nightly `/loop` or systemd-timer wiring is Phase 12.x or part of Phase 17 polish.
- **No init script.** `harness init` is a stub; Phase 16 (inquirer-driven per operator note 2026-05-02). Phase 16's E2E-setup question (per operator pivot 2026-05-02): "Set up E2E now / Defer / Skip" — branches into running setup:uat-browsers + setup:uat-sql + setup:uat-docker per stack profile.
- **No git commit + push from a successful run.** The orchestrator stops after backprop's local commit; the push to `origin/main` is gated on the pre-push evidence-file recompute per L16/L17/L18 trust posture (Phase 16 wires the push step).
- **Decision-capture refinement step.** Phase 14 v1 stores candidate_assertions under a loose `candidate_assertions:` frontmatter field; lifting them to the strict `assertions:` form (which Layer-D sensors enforce) needs Phase 14.x — operator edit-loop that fills in the schema-required parameters per assertion kind.

The `harness watch`, `harness mirror`, `harness mcp serve`, `harness run`, and `harness gc {sweep,run}` CLIs work today. End-to-end ingest → tightener → mirror → agent → sensors (Layer A/B/D + decision-assertions) → reviewer subagent (Layer C, fresh context) → UAT pipeline (multi-probe http/cli/ui/sql-sqlite/integration routing, evidence-file gate) → adapter approval → backprop (Layer §V — invariant + regex sensor + chore(invariants) commit on mirror) runs cleanly. GC composes five passes (frontmatter freshness, generator drift, stub-catalog hits, doc-gardening, quality-grades) with an auto-merge classifier, batch canary, and rollback-on-canary-fail. Decision capture turns Discord `/direction` slash + free_text classified as `direction` into draft DEC-NNNN files, fires the 🟢/🟡/🔴 confirm dialog, and on commit regenerates the decisions ledger. Next missing pieces: trial-run pilot, candidate-assertion refinement, the eventual git-push step gated on the recomputed evidence hash, and the GC cron schedule.

### Phase 11.5 design notes (binding)

- **Heavy probe deps live in devDependencies, not deps.** `playwright-core` and `better-sqlite3` install only in this repo, not in adopting projects (devDeps aren't installed transitively). Adopters opt in via `setup:uat-browsers` / `setup:uat-sql` which add the deps to THEIR project's package.json. Init script (Phase 16) automates this when operator picks "Set up E2E now."
- **Browsers ship separately from the API.** `playwright-core` is small (no auto-download). Chromium binary lives at `~/.cache/ms-playwright/chromium_headless_shell-<rev>/`. `setup:uat-browsers` runs `npx playwright install chromium` once.
- **better-sqlite3 native binding has the same path-with-spaces problem as smart-whisper.** node-gyp's generated Makefile doesn't quote `module_root_dir`, so projects living at `/Users/<name>/Documents/...` fail to build. `setup:uat-sql --build-binding` reuses the setup-whisper /tmp-staging trick: copy the package to a no-space path, build there, copy `build/` back.
- **SQL probes are READ-ONLY by contract.** The runtime rejects any query that doesn't start with SELECT/WITH/SHOW/EXPLAIN/PRAGMA — DDL/DML never runs as a probe. Defense-in-depth: even if the agent emits a malicious query, the regex gate rejects it before the driver opens the file. Probe runner additionally opens sqlite in `readonly: true` mode.
- **Integration probe ALWAYS tears down compose**, even on failure mid-test, via try/finally pattern. A failed test that leaves containers running is worse than a clean abort.
- **Connection credentials never live in YAML.** `sql.yaml` carries `user_env` / `password_env` keys naming env vars; the driver looks up the actual credentials at runtime from `process.env`. Per operator: secrets in env, brand/host/port in YAML.
- **smoke-uat is environment-aware.** Live UI/SQL probe steps detect their dependencies via dynamic `import().catch(() => null)` and SKIP when missing, so the smoke runs the same way in this repo (where devDeps are installed) and in adopting projects that haven't run setup:uat-* yet.

### Phase 11 design notes (binding)

- **UAT is multi-probe, not Playwright-only** (per operator pivot 2026-05-02). The UAT-runner agent picks the cheapest probe per AC: `http > cli > sql > ui > integration`. Opening a browser to test an API call is a defect; the prompt enforces this and the runner has defense-in-depth filtering.
- **Probe surface availability is hint-driven**, not detected. The orchestrator passes `OrchestratorOptions.uatHints` (base_url / cli_prefix / cli_cwd / ui_available / sql_available / integration_available) through to the UAT-runner, populated from the project's `<project>:` extension block at adoption. The runner refuses to emit ui/sql/integration probes when their flags are false, even if the model produced one.
- **Evidence-file gate is probe-agnostic.** `.uat-passed` carries a per-file SHA256 list + a bundle-level SHA256 over the sorted `path<tab>sha256` manifest. Pre-push gate must (1) parse the file (rejects bare-touch), (2) recompute every per-file hash (rejects post-hoc artifact mods), (3) recompute bundle hash, (4) reject extra files not in the manifest (catches "agent dropped a backdoor file after evidence written"), (5) verify `operator_decision === "approve"` (default; configurable via `verifyEvidenceFile({ requireDecision })`).
- **Phase 11 v1 fails-terminal on UAT failure.** UAT_PIPELINE §6 specifies a rejection.yaml-driven retry; that lands in Phase 11.x. v1 marks the run failed with the operator's rejection reason or the probe failure summary so the operator knows what to fix manually.
- **Persistent UAT.md per task** (`.harness/tasks/<task_id>/uat.md`) per GSD pattern. `blocked_by` (env issues — server down, third-party rate-limit) is NEVER folded into Gaps. Crossing the boundary triggers unnecessary fix-plan cycles per UAT_PIPELINE §8.
- **Adapter approval gate uses existing `requestApproval(ApprovalBundle)`.** No new adapter contract. The orchestrator maps `Approval` → UAT decision; the stub adapter's default-approve makes the smoke pure-mechanical.

### Phase 14 design notes (binding)

- **Two ingress paths, one extractor.** Discord `/direction <text>` slash (kind=slash, command=direction) AND free-text Tier-0-classified as `direction` (kind=free_text, intent=direction) both land in `.harness/inbox/` and the orchestrator routes them through the same `runDecisionCapture` flow. No path-specific behavior.
- **Capture is independent of the task FIFO.** `handleDirectionRow` fires inline from `absorbInboxFile` rather than enqueueing a task. Decision capture should not be blocked behind a long-running implementer run, and it does not consume sensors/UAT quota.
- **Tier 1 default per workflow.md.** `decisionExtractorTier` defaults to haiku per `decision_extractor: 1`. Sonnet override exists for long-form directions where Haiku miss-classifies; not the default per L42 budget concerns.
- **Anti-fabrication: `not_a_decision` short-circuits.** When the extractor sets `not_a_decision=true`, the harness writes NO draft and returns `short_circuited: true`. The prompt explicitly biases toward setting this true on rambling/off-topic/question-shaped input — a false-positive draft pollutes the ledger; a false-negative is recoverable via re-submission.
- **Candidate assertions are loose proposals, not strict assertions.** The extractor's `candidate_assertions` array carries a `kind` + `description` + free-form `parameters` object. They're stored under FRONTMATTER `candidate_assertions:` (passthrough) — NOT under strict `assertions:` which `DecisionFrontmatter` zod validates. Reason: a partially-specified `query_must_filter_by` candidate would fail strict validation and bork the ledger regenerate. Phase 14.x lifts candidates into `assertions:` only after operator edit fills in schema-required parameters per kind.
- **Monotonic ids burn through tombstones.** Per L13.2, even rejected drafts keep their DEC-id forever. `rejectDraft` writes a `.rejected.md` tombstone (status:rejected, body preserved for audit) instead of `rm`-ing the file. `allocateDecisionId` scans both `.draft.md` and `.rejected.md` files when computing the high-water mark — so DEC-0001 cannot resurrect after a reject + retry.
- **Confirm dialog timeout = edit, not reject.** When `requestDialog` times out (default 60s; smokes drop to 1s), the flow treats it as `edit` so the draft survives in `_inbox/` for the operator's return trip. Reject would lose the capture; commit on timeout would be an accidental ledger update. Edit is the safe middle.
- **Supersedes is operator-driven, not inferred.** The extractor only sets `supersedes` when the input EXPLICITLY revokes a prior decision (`scrap DEC-0042`, `undo the FK denorm rule`). On accept, `acceptDraft` stamps `superseded_by:` on the referenced decision file (best-effort — missing referent doesn't block). The next ledger regenerate excludes the superseded entry per existing `superseded_by` filter.
- **Source field encodes provenance.** `<source>:<kind>` — e.g., `discord:slash`, `discord:free_text`, `smoke:commit`. Stored in draft frontmatter as `capture_source:` for audit; cited in extractor logs. Discord-specific data (channelId, guildId) survives via the inbox row but is not duplicated into the decision file.

### Phase 13 design notes (binding)

- **Backprop runs after UAT pass, not before.** Sequence: sensors → reviewer → UAT → operator-approve → backprop → done. A failed UAT skips backprop entirely (no invariant for a fix that hasn't shipped). The orchestrator's `bypassBackprop` smokes around it; production runs invoke unconditionally on code-class.
- **Tier matches implementer by default.** Per workflow.md `backprop_author: 2`, the default is Sonnet. The orchestrator option `backpropTier` overrides; smokes drop to Haiku for ~$0.05 quota. L15's "context isolation > model split" applies symmetrically: a fresh-context Haiku still produces a usable invariant from a small diff.
- **Agent emits structured payload only — harness writes the files.** Backprop subagent has NO file-write tools. The schema constrains output to slug + title + body_markdown + introduced_for_bug + enforcement{...}. The harness mints the V-id, materializes the frontmatter, and emits the sensor boilerplate. Keeps the agent surface narrow + portable across model upgrades.
- **Invariant ids are monotonic, never reused (L13.2).** `allocateInvariantId` scans every `V<NNNN>.md` in `.harness/ground/invariants/` (including superseded ones) for the high-water mark and returns mark+1. Even an invalidated invariant keeps its id; the file gets `status: superseded_by: V<later>` rather than deletion.
- **Two enforcement kinds, regex_sensor by default.** Most invariants are mechanically detectable: a regex over a target glob set. The schema also allows `named_e2e` for invariants that only show up at runtime (cross-tenant scope, multi-step user flows, async event ordering). The agent picks; the harness handles both. The smoke prefers regex_sensor and warns when the agent picks named_e2e.
- **Sensor template is self-contained tsx.** The generated sensor is a single tsx file under `harness/scripts/check-v<N>-<slug>.ts` with embedded REGEX/TARGET_GLOBS/LANGUAGE/FAILURE_MESSAGE constants and zero imports beyond `node:fs` + `node:path`. Self-containment lets the sensor work in any adopting project regardless of harness install state, and it's executable as `tsx check-v<N>-<slug>.ts <repo-root>`.
- **Failure summary is best-effort.** The orchestrator constructs it from soft-sensor-findings on the run + UAT-rejection-note (when present, even though we only invoke on UAT pass — the operator can approve with a note that becomes context) + task body fallback. When all are empty, the prompt's escape hatch produces a wildly-permissive regex with body_markdown that says "no enforceable invariant; fix was cosmetic" — better than fabricating one.
- **Commit is local-only.** The orchestrator's `runBackpropStep` writes the invariant + sensor in the mirror and commits `chore(invariants): add §V<N> from run <id>` via simple-git. Push happens later in Phase 16. The smoke confirms commit lands on the mirror's HEAD; push verification belongs to the adopt-time pilot.
- **Smoke degrades gracefully on agent quality issues.** When the agent's regex is too permissive (misses regression) or too aggressive (hits the FIXED code), the smoke reports OK-with-warning rather than failing. The harness *infrastructure* (allocator, writer, schema, sensor template, commit) is verified independent of LLM judgment quality. A degraded sensor still records the invariant; the operator can refine the regex via a follow-up run that supersedes it.

### Phase 12 design notes (binding)

- **Five passes, one composer.** `runGcSweep` always runs all five passes. Findings + commit proposals come back together. `runGcBatch` is the apply-side wrapper that filters proposals by class and runs canary verification.
- **Auto-merge classes default to safe-only.** `harness gc run` (and `runGcBatch` programmatic) accept `applyClasses` as a list. The default `["safe"]` matches L16. Operator opts code/high-stakes in explicitly per run. The classifier never auto-promotes; high-stakes globs dominate, code extension dominates over safe.
- **Frontmatter freshness is surface-only by default; bump only with `forceRefresh`.** A verified-at bump without re-verification is a lie. Phase 12 v1 produces a refresh proposal only when the operator (or smoke) explicitly opts into `forceRefresh: true`. The proposal is frontmatter-only — body is preserved. Future revisions will gate the auto-bump on a content-sha-stable check.
- **Stub-catalog GC walks the FULL source tree, unlike Layer A.** Layer A in `src/sensors/stub-catalog.ts` flags only newly-added lines per diff (avoid paying for pre-existing debt every run). The GC pass closes the loop on accumulated debt — walks all source files (skipping .git/node_modules/dist/.archive/etc.), runs the same regex catalog. Phase 12 v1 surfaces only; targeted-refactor proposals deferred to a richer Phase 12.x.
- **Quality-grades pass ignores `generated:` timestamp churn.** `quality-grades.yaml` carries a `generated: <ISO>` that changes every build. The pass compares the modules array as JSON (timestamp ignored) and only proposes a write when modules content actually changed. No churn commits.
- **Doc-gardening uses orientation-file allowlist.** `AGENTS.md`, `CLAUDE.md`, `README.md`, `RESUME_PROMPT.md`, and the four `.harness/config/*.{md,yaml}` shipped with the harness are NEVER flagged as orphans (nothing links to them by design — they're roots). Operator can extend via `orphanExcludes` per-project.
- **Canary fires only when batch lands ≥2 commits.** Per L46. A single commit is not a "batch" and the canary's value is detecting "individually safe, collectively broken" — which requires multiplicity. Single-commit batches skip canary; the per-commit safety is enforced by the proposal's class.
- **Canary check is mechanical: workflow.md re-render + manifest rebuild.** Render `templates/.harness/config/workflow.md` body against `buildSyntheticContext()`, assert (a) every `{{var}}` resolves, (b) required section headings present, (c) `buildManifest` returns >0 entries against the post-batch tree. No claude burn. Future revs add a synthetic-diff sensor sweep (Phase 12.x).
- **Rollback is `git reset --hard <pre_batch_sha>`.** When canary fails, the entire batch — every applied commit — is undone atomically. The operator sees the failures in `canary_failures` and the surfaced proposals so they can retry manually.

### Phase 10 design notes (binding)

- **Reviewer tier matches implementer.** Per L15, what catches blindspots is context isolation, not weight diversity. The orchestrator passes `defaultTier` to both. Operator can override per-run via `runReviewer({ tier })` if a riskier run wants Sonnet review of a Haiku implementation, but that is not the default — both burn the same plan quota.
- **Reviewer sees the diff content, not the implementer's reasoning.** `runReviewer` reads diff via `getDiff(mirrorPath, shaPin)` — same source as sensors. Each changed file's post-change content is included in the user prompt up to 32k characters per file (cap exists for large generated artifacts; trim with care if you raise it).
- **High-stakes augmentation is glob-driven.** When `projectGlobs.high_stakes_globs` overlaps the diff, the prompt appends an explicit query-scope completeness paragraph per Codex audit Q1.
- **Verdict gating.** `result.ok = verdict === "pass" && hard_gaps === 0`. A reviewer that returns verdict:fail OR any hard gap blocks the run. Soft gaps are advisory; they show up in `last_reviewer.soft_gaps` and are intended for the eventual UAT bundle (Phase 11) to surface to the operator.
- **Retry loop is unified.** Phases 9 + 10 share the same `attempt` counter and the same `maxAttempts` cap (default 3 per L42). The remediation body that's appended on retry is whichever rejected the run — sensor remediation OR reviewer remediation, not both. Operator wants attempts to be a real budget, not "3 sensor + 3 reviewer = 6".

### Phase 9 design caveats (binding)

- **Decision-assertion regex approximations.** `ast_pattern`, `query_must_filter_by`, `event_must_emit`, `service_method_must_call` use windowed regex. Soft-finding fallback when the assertion can't be verified with confidence — reviewer subagent (Phase 10) catches what regex misses. AST precision = v2 task.
- **Layer D structural sensors are NestJS+FastAPI-flavored heuristics.** Rails, Go, Rust, Django need profile-driven equivalents in Phase 16. The `route_handler_globs` + `dto_globs` plumbing already routes them generically — only the regex internals need stack-specific siblings.
- **Layer A line-add discrimination.** Stub patterns flag only NEWLY-added lines (line not present in `beforeContent`). Pre-existing debt is invisible to a single run. Backprop (Phase 13) + GC (Phase 12) handle accumulated debt.
- **Layer B attestation extraction.** Tolerates either fenced ` ```yaml ... ``` ` or bare top-level YAML starting with `attestation:`. Missing block = hard fail. The agent prompt (`templates/.harness/config/workflow.md`) requires emission.

## 2. Operator profile (binding)

Match this style exactly:

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. No preamble. Lead with answer/action. No filler. |
| Decisions | Fast-intuitive. Don't present options unless explicitly asked. When operator states a decision, treat it as final. |
| Explanations | Concise. Root cause in 1-2 sentences then fix. |
| UX Philosophy | Design-conscious. UX equal in importance to functional correctness. |
| Vendor Choices | Opinionated. **Do not suggest alternative libraries/frameworks unless they avoid real risk.** |
| Env vars | **Hates env vars.** Quote: *"I hate env vars, it's more moving pieces, the only thing that should be stored in env is stuff that might change, like brand domain, secrets, etc."* Hardcoded model IDs in code = correct. |
| Tests | *"Tests are shitware, the only tests that matter truly is E2E with real db."* **Drop test framing entirely.** Sensors and E2E real-DB only. |
| Backward compat | *"We DO not care about legacy or backward compat, we are very early in development."* Hard cutovers. No transition shims. |
| AI features | AI is the platform. Default tilt: implement, not strip, when uncertain. EXCEPT when AI is misaligned product debt — then strip without hesitation. |
| Frustrations | Instruction-adherence. Follow exactly. Don't add framing/features they didn't request. Never report done unless fully satisfies criteria. |
| Mobile mode | When operator is on mobile, `AskUserQuestion` options get truncated. Switch to chat-mode K/R/U/M with concise option labels. |
| UX rule (load-bearing) | **Squares-into-square-holes.** Always propose A/B/C/D before asking for typed input. Free-text only as escape (`E) Other`). |

**Caveman ultra mode is active for chat replies.** Output format = `[thing] [action] [reason]. [next step].` Drop articles, filler, pleasantries. Fragments OK. Code/commits/PRs/documents written normal full English.

## 3. Doc state — what exists

Inside `docs/`:

| File | Status | Purpose |
|------|--------|---------|
| `PRIMER.md` | ✅ written (v2, ~570 lines) | Concepts, principles, anti-patterns, glossary |
| `INTEGRATION_PLAN.md` | ✅ written (v2, ~430 lines) | 19 phases for the build |
| `FILESYSTEM_LAYOUT.md` | ✅ written | Disk layout for any adopted project |
| `MCP_SURFACE.md` | ✅ written | 16-tool MCP server schemas |
| `UAT_PIPELINE.md` | ✅ written | UAT-on-phone via Discord buttons |
| `WORKFLOW_GUIDE.md` | ✅ written | Operator UX rules + tier ladder |
| `QUESTIONS.md` | ✅ regenerated (v2) | Residual open items (most defaults locked) |
| `CODEX_REVIEW_BRIEF.md` | ✅ written | Self-contained brief for the Codex audit pass — operator pasted into Codex to get a second-model independent review |
| `CODEX_REVIEW_BRIEF_REVIEW.md` | ✅ Codex's response, folded into docs 2026-05-02 | 13 findings: 3 must-fix (mirror dirty-overlap, decision-assertion DSL expansion, stack profiles), 9 should-revisit, 1 note-for-record. All folded into the relevant docs. Disagreement preservation: §15 below. |
| `_research/STALENESS_INVENTORY.md` | ✅ existing | Mypal docs staleness audit |
| `_research/DISCORD_WHISPER_DESIGN.md` | ✅ existing | Discord+Whisper feasibility |

**Frontmatter `depends-on:` paths inside the docs may still reference `docs/orchestration/...` from the prior mypal location.** A path-fixup pass replaces those with relative paths inside `docs/`. If the operator hits broken pointers, run that fixup.

## 4. Locked architectural decisions (binding)

Treat these as final. Do NOT reopen without explicit operator instruction.

| # | Decision | Rationale |
|---|----------|-----------|
| L01 | TypeScript-first stack | Operator uses Claude Code primarily; mypal is TS-everywhere; consistency |
| L02 | pnpm monorepo workspace package (`harness/`) inside the harness project itself | Same pattern as mypal's `core/`, `platform/`, etc. Generic via `npx @devplusllc/harness init` for other projects |
| L03 | Filesystem-only state — no database (no Postgres, no Notion as primary) | Operator preference: visible, version-controlled, auditable, simple |
| L04 | Two-zone canonical/historical separation, hook-enforced | Stale never sits next to live. Eliminates the "two truths in context" failure mode |
| L05 | Direct commits to `main`, NO branches, NO PRs | Solo dev; branches = waste; harness commits like a developer |
| L06 | Parallel mirror checkout at `~/.local/harness/repos/<project>/` | Harness operates here; user's working tree is sacred |
| L07 | Concurrency = 1 (single-task FIFO pipeline) | Operator works sequentially; multi-task adds coordination overhead |
| L08 | **Frontend adapter is pluggable.** Operator console adapters: `discord`, `notion`, `cli`, future `web`. The orchestrator + grounding daemon + MCP are frontend-agnostic. Operator can register multiple simultaneously. Discord is default; Notion is a peer (operator's friend prefers it). | Generic harness must not pick winners. WORKFLOW_GUIDE §0 covers the adapter contract. |
| L09 | Channel-per-task with category lifecycle (📋 backlog / 🟢 active / 📦 archive) | Visible state at a glance |
| L10 | Local Whisper via `whisper.cpp` (Homebrew) + `smart-whisper` TS binding | TS-everywhere; Metal+CoreML on M-series; zero API cost |
| L11 | Whisper model: `large-v3-turbo` Q5_0 | ~95% accuracy, ~800MB, ~3s for 30s clip |
| L12 | Audio NEVER written to disk | PII risk; transcript only |
| L13 | Squares-into-square-holes UX (A/B/C/D dialogs) | Operator's stated preference; no CLI flag memorization |
| L14 | Tier ladder for model selection | Tier 0 (Ollama llama3.2:3b for classification) → Tier 1 (Haiku 4.5) → Tier 2 (Sonnet 4.6) → Tier 3 (Opus 4.7). Auto-escalate on assertion-violate or structure-fail |
| L15 | Reviewer subagent uses SAME model as implementer, fresh context (no Opus burn) | Context isolation catches blindspots, not weight diversity |
| L16 | Auto-merge: Option A (safe-class auto-merges to main, no UAT) | Operator accepts blast radius; safe-class is narrow (formatting, regen, frontmatter, archive moves) |
| L17 | Auto-merge: code-class requires sensors + reviewer + UAT 🟢 | Bigger blast radius gets bigger gate |
| L18 | Auto-merge: high-stakes requires above + E2E real-DB + Layer E demo | Highest blast radius, highest gate |
| L19 | Backprop protocol — every fix → §V invariant + sensor + naming convention | From cavekit; turns repeats into preventable cases |
| L20 | Garbage collection cadence — nightly background drift sweep | From OpenAI's harness; continuous curation, not one-time cleanup |
| L21 | `AGENTS.md` = TOC pattern, ~150 lines max | OpenAI tried "one big AGENTS.md" and it failed; progressive disclosure required |
| L22 | All operator I/O multiple-choice-first | Free-text only as escape hatch |
| L23 | Voice-note rejection on UAT 🔴 → Whisper transcribes the rejection reason | Same pipeline both ways |
| L24 | `/ship-anyway` operator override | For trivial spec-tightener cases or sensor false-positives |
| L25 | Stub-pattern catalog (Layer A) grows via `/oops` dialog only — NO CLI commands | Operator picks A/B/C/D; harness extracts pattern automatically |
| L26 | Decision assertions are machine-readable (kinds: `schema_must_contain`, `text_must_*`, `index_must_exist`, `ast_pattern`, `file_must_not_be_modified`) plus `human_review_hint` fallback | Mechanical evaluation against diff; fail loud |
| L27 | Decision capture flow — Discord 🟢-confirm with extracted candidate; tightener prompts "what assertions?" at confirm time | Decisions survive across runs; can't be ignored |
| L28 | No phase-gates between modules | Harness adopts modules as operator opts in; no GSD-style ceremony |
| L29 | Snapshot pinning per run (origin/main SHA at start) | Eliminates "wait what changed?" investigations |
| L30 | MCP retrieval is structured graph traversal, NOT freeform query | Deterministic; agent traverses by id/path-glob, not fuzzy match |
| L31 | Append-only writes via MCP (`harness_append`, `harness_record_decision`, etc.) | Saves N file reads per write; no read-before-write penalty |
| L32 | Custom linter remediation messages — failure messages are agent-prompt-shaped | Per OpenAI: *"the lints are custom, they write the error messages to inject remediation instructions into agent context."* |
| L33 | Evidence-file gate (`.uat-passed` SHA256) | Bare `touch` rejected; agent can't fake UAT |
| L34 | Provenance frontmatter required on every load-bearing markdown in canonical zone | CI-enforced; staleness mechanically detectable |
| L35 | Stale doc lifecycle = MOVE, not flag. Move to `.archive/<date>/<original-path>` | No `[STALE]` banners; canonical tree always clean |
| L36 | Generic harness pkg + per-project `.harness/config.yaml` | Portable; mypal-specific config never bleeds into harness pkg |
| L37 | `npx @devplusllc/harness init` runs deep mapper (Tier 2 LLM, one-time, OK to spend tokens) | Deep project mapping at adoption time |
| L38 | Ollama for cheap classification | Solo-dev cost: $0 for Tier 0 work |
| L39 | Codex peer review pass before implementation | Operator wants a separate-model-family audit; brief at `docs/CODEX_REVIEW_BRIEF.md` is self-contained for ingestion |
| L40 | Codex review folded in 2026-05-02 | All findings from `docs/CODEX_REVIEW_BRIEF_REVIEW.md` patched into doc set. Must-fix items: mirror dirty-overlap gate (L45), decision-assertion DSL expansion (L41), stack profiles (L47), GC batch canary (L46), cross-tenant fixture for high-stakes UAT (L43). Should-revisit items folded inline. |
| L41 | Decision-assertion DSL expanded with behavioral kinds | Added: `query_must_filter_by`, `route_must_have_guard`, `event_must_emit`, `service_method_must_call`. Original schema/text/index kinds retained. See `docs/FILESYSTEM_LAYOUT.md` §4 example. |
| L42 | Budget metric is Claude Code coding-plan quota, NOT $/day | Per operator answer T1. Dollar tracking remains as record-only audit. Pre-run cost projection + Tier-3 explicit-approval + per-task max attempts (3) replace post-hoc dollar alarms. See WORKFLOW_GUIDE §2.2. |
| L43 | High-stakes UAT MUST include cross-tenant negative fixture | Per Codex audit Q1. Closes the "filter by provider only, omit user_id" leak. Implementations that pass other gates but miss user_id scoping are caught at the cross-tenant fixture. |
| L44 | Operator dialog cap: 2 questions per turn | Per Codex audit Q5/Q7. If 3+ ambiguities, harness collapses to a single tightened-spec proposal + `[approve | edit | rewrite]` choice. Prevents "ceremony by another name." |
| L45 | Pre-dispatch + pre-push `local_dirty_overlap` gate | Per Codex audit Q3. Daemon checks user's working tree against run's `target_path_globs`; pauses run if overlap; offers operator A/B/C resolution (stash / cancel / wait). |
| L46 | GC batch canary | Per Codex audit executive summary. Multi-commit GC batches must (a) re-render WORKFLOW.md against synthetic-task fixture and (b) re-run sensors against post-batch `main` snapshot before pushing. Catches "individually safe, collectively broken." |
| L47 | Stack profiles for portability | Per Codex audit Q8. Init script detects stack and selects profile: `typescript-next-nest`, `python-fastapi`, `python-django`, `rails`, `go`, `rust`, `unknown`. Each owns sensors, start commands, hook strategy, off-limits/high-stakes defaults. Harness pkg has zero TS/pnpm/Drizzle hardcoded assumptions. |
| L48 | `collaboration_mode: solo \| team` config | Per Codex audit Q9. Default `solo` keeps direct-commit-to-main. `team` re-enables branch+PR workflow with required gate. Init script defaults from `git log --format=%aE \| sort -u \| wc -l` heuristic. |
| L49 | Distribution mechanism for early testers | Per operator answer M1. Private GitHub repo via `npm install <git-url>`; tarball via `pnpm pack`; or symlink-clone for collaborative debug. Eventual `npm publish @devplusllc/harness` once stable. |
| L50 | Project-agnostic harness pkg code (no hardcoded project names) | Per operator answer S1: "the harness should propose sensors, agnostically, like dont mention 'mypal.' ANYWHERE within harness code, only internal docs." Pkg reads project-specific extension block via `Object.keys()` lookup keyed on adopting project's package name. mypal-specific text in this doc set is illustrative, not source. |
| L51 | A2 — pilot SCOPE is full mypal repo, not just integrations module | Per operator answer A2. `pilot_module: ALL` in WORKFLOW.md `mypal:` block. High-stakes globs trigger Layer E + cross-tenant fixture for sensitive areas. |

## 5. Anti-patterns we deliberately reject (named)

Treat any agent suggestion that lands on this list as a defect.

| Anti-pattern | Why we reject |
|---|---|
| **Hot-path LLM arbitration** (claude-mem) | LLM invoked on every tool call to decide whether to remember → tokens burned regardless of answer. Pre-filter deterministically; LLM only for transformation, not gating. |
| **Mandatory ceremony before code** (GSD's 8-question init) | Solo dev with established codebase ≠ greenfield. Default fast; opt-in depth. |
| **One-big-AGENTS.md** | OpenAI tried it, failed. AGENTS.md = TOC, ~150 lines max. |
| **Subagent swarms / parallel waves / dashboards** | cavekit v3 → cut in v4. Coordination cost > benefit at solo-dev scale. |
| **Per-task token budgets / completeness grades / model-tier UI ceremonies** | Overhead without measurable benefit. |
| **Confidence scores on writes** | No model-issued confidence as gate or surface. |
| **Mocked tests piled in to look thorough** | Operator's stated stance. Sensors + E2E real-DB only. |
| **Branches and PRs for solo-dev** | Direct commits to main. |
| **CLI commands for every small action** | Multiple-choice dialog (squares-into-square-holes) replaces typed args. |
| **Backward-compat shims, deprecation notices, redirects** | Hard cutovers. No transition regex. No "moved to X" stubs. |
| **Stale doc with `[STALE]` banner** | Stale → moved to `.archive/`. Banner-flagging keeps it next to live; we don't. |
| **Agents writing to ground** | Ground is mechanically generated by the daemon. Agents read; they don't write. |
| **Postgres / SQLite / DB for harness state** | Filesystem only. Operator preference. |
| **Notion as primary STATE** | Third-party dependency; deferred indefinitely. NOTE: Notion as a *frontend adapter* is fine and supported per L08 — that's UI, not state. The state layer stays on filesystem. |

## 6. Mining-derived patterns we adopted

| Source | Adopted |
|--------|---------|
| **OpenAI harness (Feb 2026)** | Garbage collection cadence; "instructions decay, enforcement persists" principle; custom linters with agent-prompt-shaped error messages; AGENTS.md as TOC; 5 verbatim quotes |
| **Symphony spec (Apr 2026)** | 6-layer architecture; 8-component decomposition; `WORKFLOW.md` repo-owned policy; hot-reload with last-known-good fallback; deterministic-named workspaces; no durable orchestrator DB |
| **cavekit v4** | Single-file SPEC philosophy applied to bounded canonical artifacts; backprop protocol (every fix → §V invariant + sensor + naming convention); §T STALE detection; monotonic never-reused IDs; `from-code` retroactive init |
| **GSD** | Canonical-refs section in spec; `<decisions>` vs `<discretion>` split; requirements-as-hypotheses; persistent UAT.md across context resets; cold-start smoke injection; `blocked_by` tagging separate from Gaps |
| **claude-mem** | Anti-pattern named ("hot-path LLM arbitration"); 3-layer progressive retrieval (search → timeline → fetch) for read side |
| **workos community pattern (OpenAI-inspired)** | Evidence-file gate (`.uat-passed` SHA256-of-output); blocks PR creation without real evidence |

## 7. Six-layer honest-agent invariants stack (full detail in PRIMER §10)

```
[task spawned]
  → [F: spec tightener — Tier 1 LLM, single call, kills bad specs before code]
  → [agent runs in mirror, change uncommitted]
  → [A: mechanical stub-pattern catalog — Layer A]
  → [B: attestation cross-check — agent's self-report vs evidence]
  → [D: project-specific sensors — stub-allowlist, event coverage, etc.]
  → [decision-assertions sensor — machine-readable assertions per accepted decision]
  → [C: reviewer subagent — same model, fresh context, anti-completionist framing]
  → [E: high-stakes only — demo / E2E real-DB]
  → [U: UAT-on-phone — headless Chrome → GIF → Discord button → evidence-file gate]
  → [git commit + push to main]
  → [backprop: §V invariant + sensor + naming convention]
```

Each layer fail → run marked `failed-honesty-check` with structured findings. Sensor failure messages are remediation prompts (per OpenAI pattern); agent retries with the failure context as new prompt input.

## 8. Recently-completed in-session work (so you don't redo it)

- Spawned 4 Sonnet subagents to mine: `JuliusBrussee/cavekit`, `thedotmack/get-shit-done`, `thedotmack/claude-mem`, OpenAI harness articles. Reports synthesized into PRIMER §3 (Symphony), §11 (anti-patterns), §12 (GC cadence), §13 (backprop).
- Wrote v2 of all 4 originally-drafted docs (PRIMER, INTEGRATION_PLAN, FILESYSTEM_LAYOUT, MCP_SURFACE).
- Wrote 2 new docs (UAT_PIPELINE, WORKFLOW_GUIDE).
- Regenerated QUESTIONS.md to v2.
- Moved everything from `mypalcrm/docs/orchestration/` to `Harness/docs/`. Cleaned up old location.

## 9. Locked operator answers from the discussion

| Question | Locked answer |
|----------|---------------|
| Discord channel-per-task lifecycle | Yes — auto-create on task land, thread runs, archive on close |
| Grounding daemon trigger | chokidar filesystem watcher (debounced 500ms) |
| Portability scope | Generic `@devplusllc/harness` package + per-project `.harness/config.yaml`; init script does deep mapping (LLM-OK, one-time) |
| `.archive/` location | Committed to repo (single source) |
| Auto-merge classes | Option A — safe-class auto-merges; code-class needs sensors + reviewer + UAT 🟢; high-stakes adds E2E |
| Reviewer model | Same as implementer (no Opus burn); subagent context-isolation |
| Spec-tightener model | Haiku for short specs, Sonnet for complex |
| `/ship-anyway` override | Yes |
| Tests in plan | Dropped entirely; E2E real-DB + sensors only |
| Layer A catalog | Seeded at init in `.harness/config/stub-patterns.yaml`, additive over time, grows via `/oops` dialog (no CLI) |
| Decision capture flow | Discord 🟢-confirm; tightener prompts "what assertions?" at confirm time |
| Plan re-entry | Phased rollout; no phase-gates between modules; harness adopts modules as user opts in |
| **Operator's QUESTIONS.md answers (locked 2026-05-02)** | |
| P1 project name `Harness` | default |
| P2 package name | `@devplusllc/harness` (NOT `@isaac/harness`) |
| A1 first adopted project | mypal |
| A2 pilot scope within mypal | **full repo** — operator quote: *"no? we are implementing harness on the full project"* |
| A3 off-limits paths | defaults accepted; operator will clean stale/canonical paths before deployment |
| F1 frontend adapters at v0 | discord only |
| G1 minimum bar for code-class commit | middle ground between code-class and high-stakes — "I want it to be simple" |
| G2 unrecoverable failures | defaults accepted |
| G3 weekly metric | "obviously slop code will happen, but if harness doesn't catch it, then it defeats the purpose" — primary metric is harness catch-rate on slop |
| D1 Discord guild ID | `1487133145013944443` (mypal. discord) |
| D2 owner Discord user-ID | `1264005138918408204` |
| D3 bot identity | default `mypal-harness` |
| D4 DM enabled | default yes |
| N1-N4 Notion adapter | omitted at v0; build lazily when operator's friend wants it |
| S1 sensors | **harness pkg code MUST be project-agnostic — NO `mypal.` strings ANYWHERE in harness code, only in internal docs** — operator quote verbatim. Harness proposes; user approves per sensor at adoption. |
| S2 sensor disable list | default — all enabled at adoption; disable per-failure via /oops |
| T1 budget | **drop $/day** — Claude Code subscription quota IS the metric — operator quote: *"the only metric that matters is the claude code usage"* |
| T2 self-disable paging | active frontend adapter |
| M1 distribution | private GitHub repo OR tarball OR symlink for early testers; eventual `npm publish @devplusllc/harness` |
| M2 auto-install Ollama | yes (with A/B/C dialog at init) |

## 10. What the operator wants next (most likely)

Phase 14 is complete. Next is **Phase 15 — trial-run pilot** (`docs/INTEGRATION_PLAN.md` §5 Phase 15; ~2 founder-days).

Phase 15 deliverables (per spec):

1. **Pilot task** — a real backlog item from an adopted project (mypal): e.g. "add unique partial index on `integration_oauth_tokens(provider, user_id) WHERE archived_at IS NULL`".
2. **Submission via `/task` slash + dialog OR voice note** — full ingress path exercised end-to-end.
3. **Watch full lifecycle** — spec tightener → mirror prep → agent run → sensors → reviewer → UAT-on-phone → 🟢 → push to main → backprop. (Push step lands as part of this phase or Phase 16.)
4. **Voice variant** — same task as voice note → assert transcription → intent classification → full pipeline.
5. **Decision-capture variant** — `/direction "actually, also add the symmetric index for archived_at IS NOT NULL"` → confirm → next run sees it in ledger.

Quicker alternatives if operator prefers smaller scope:

- **Phase 12.x — GC cron schedule** (`/loop` or systemd-timer wrapping `harness gc run`) — ~0.25 founder-day.
- **Phase 14.x — candidate-assertion refinement** — operator edit-loop that lifts candidate_assertions into the strict assertions schema so Layer-D enforces them. ~0.5 founder-day.

### Phase 16 init script E2E setup (referenced from operator pivot 2026-05-02)

Per operator pivot, the init script must ask "Set up E2E now / Defer / Skip" and branch:
- `now` → `setup:uat-browsers` + `setup:uat-sql --install [--driver sqlite|postgres|mysql]` + `setup:uat-docker` per stack profile
- `defer` → `e2e_setup: deferred` in `.harness/config.yaml`; orchestrator prompts again on first UAT need
- `skip` → `e2e_setup: skipped`; code-class UAT becomes review-only; high-stakes refuses dispatch

Do NOT start Phase 15 until the operator says "go". Confirm what's landed first.

## 11. How to start a fresh session

```
1. Read this RESUME_PROMPT.md fully (esp. §1A — implementation snapshot).
2. Read docs/PRIMER.md fully.
3. Skim docs/INTEGRATION_PLAN.md §5 Phase 15 (trial-run pilot) — that's
   what's next. Phase 14 spec/contract is settled in code; refer to the
   landed `harness/src/decision-capture/` for surface + smoke for examples.
4. Run the cheap sensors to confirm nothing has broken:
     pnpm -F @devplusllc/harness build typecheck check:layout
                                       smoke:mirror smoke:watch smoke:mcp
                                       smoke:discord smoke:tier0 smoke:sensors
                                       smoke:uat smoke:uat-rejection smoke:gc
   All cheap ones should print OK without burning claude quota.
5. Confirm to operator in 2-3 lines, e.g.:
     "Resumed Harness project. Phases 0–14 landed. Cheap sensors green.
      Ready for Phase 15 (trial pilot) OR Phase 12.x (GC cron) OR Phase 14.x (assertion refine). Proceed?"
6. Wait for direction. Don't propose anything beyond what's in INTEGRATION_PLAN.md
   §5 Phase 15 / §5 Phase 12.x / §5 Phase 14.x.
7. Caveman ultra mode active for chat replies. Documents/commits/PRs in normal
   English. Match operator's terse-direct style.
```

## 12. Tooling notes

- This is a fresh repo. No git remote yet. No CI. No `.claude/rules/` yet — the project's own rules will be drafted when implementation phases begin.
- Operator uses Claude Code primarily, sparse Codex usage.
- Operator has Notion MCP connector available but explicitly does not want to depend on it for primary state.
- Operator has Amphetamine + pmset configured for overnight workflows (not relevant here, but informs cadence).
- Operator is solo founder; no collaborators currently.

## 13. Things the operator has said (verbatim where load-bearing)

- *"the end-user Human purely just wants to be able to prompt and have a fully done project spit out"*
- *"It should feel like Im a baby putting squares into the square hole"*
- *"I'd prefer if these 'docs' were committed to the repo, and everything was clean without having any sort of problems"*
- *"AIs want UAT testing, however most times Im working im out of the house and cannot access the site"*
- *"if we use Sonnet model to code and Opus to review, we effectively just kill the limits of the coding plan"*
- *"NOTHING should be a stub. This is completely missing functionality from the site."*
- *"I find [branches] as a waste of time, especially since Im the only developer and I only start 1 task and finish 1 task before doing another"*
- *"I'm very okay with using Ollama to run simple text classification tasks, given that it would be a significant downgrade from a professional model"*
- *"I want everything setup for me to just click the button the AI provides, do whatever it asked and then just confirm or not"*
- *"this is a completely seperate project I want to give it that same respect"* (motivated this very file)
- *"the discord part is more of a feature, I have a buddy that likes using Notion so it should be built slightly agnostic"* (drove L08 frontend pluggability)
- *"I want to run this entire system through a pass of Codex"* (motivated `docs/CODEX_REVIEW_BRIEF.md`)

## 14. References

- OpenAI, *Harness engineering* (Feb 2026): https://openai.com/index/harness-engineering/
- OpenAI, *Symphony* (Apr 2026): https://openai.com/index/open-source-codex-orchestration-symphony/
- Symphony repository: https://github.com/openai/symphony
- Birgitta Böckeler, *Harness Engineering for Coding Agent Users* (MartinFowler.com, 2026-04-02): https://martinfowler.com/articles/harness-engineering.html
- Ryan Lopopolo, *Extreme Harness Engineering* (Latent Space, 2026): https://www.latent.space/p/harness-eng
- cavekit: https://github.com/JuliusBrussee/cavekit
- get-shit-done: https://github.com/thedotmack/get-shit-done
- claude-mem: https://github.com/thedotmack/claude-mem
- Mypal repo (proving ground): `/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`

---

End of resume prompt. Total context restoration target: ~98% of the previous session's working knowledge. Drop into a fresh Claude Code session at `/Users/user/Documents/DevPlus LLC/06 - Projects/Harness/` and proceed.
