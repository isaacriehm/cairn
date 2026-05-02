---
type: resume-prompt
status: handoff
audience: ai-only
generated: 2026-05-02
last-updated: 2026-05-02 (after Phase 0–5 landed)
purpose: Drop into a fresh Claude Code session in /Users/user/Documents/DevPlus LLC/06 - Projects/Harness to continue this project where the previous session left off.
---

# Resume Prompt — Harness Project

You are a freshly-spawned agent picking up an in-flight project. Read this file end-to-end before doing anything. Then read `docs/PRIMER.md`. Then confirm to the operator what you've loaded.

## 1. Mission

Build a **portable, generic agent harness for solo developers**. Discord-front-ended. Local Whisper voice input. Filesystem-only state. Honest-agent invariants stack. Direct-commit workflow. Symphony-shaped per OpenAI's open-source spec.

Mypal (a real-estate CRM at `/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`) is the proving ground. The harness package extracts cleanly to any other project via `npx @devplusllc/harness init <repo-dir>`.

**Status:** Implementation in progress. Phases 0–5 landed (~7 founder-days). Phase 6 (Whisper voice ingress) is next. **Documentation in `docs/` is still the source of truth for design; the code in `harness/` is the runtime that implements it.**

## 1A. Implementation snapshot (binding — verify against `git log` before acting)

The Harness repo is **NOT self-hosted**. It's the source for the published npm package `@devplusllc/harness`. The `.harness/` shape lives in `harness/templates/`; the init script copies it into adopting projects. Do not create `.harness/` or `.archive/` at the repo root.

### Commits landed (most recent first)

| SHA (short) | Phase | What |
|-------------|-------|------|
| _(pending)_ | 5 | Discord ingress: frontend-adapter contract, Discord adapter (slash + categories + buttons + ACL + regex Tier-0 stub), stub adapter, `harness run --frontend <name> --project <slug>` CLI, `smoke:discord` |
| `c665fce` | 4 | harness-mcp server (17 tools, stdio transport) |
| `96b2fa7` | 3 | grounding daemon (chokidar + manifest + ledgers + drift + quality grades + profile registry) |
| `ce30537` | 2 | mirror checkout runtime (clone/sync/push/dirty-overlap; `~/.local/harness/repos/<slug>/`) |
| `d011463` | 0–1 | bootstrap pkg + design docs + canonical templates under `harness/templates/` |

### Seven sensors green

```
pnpm -F @devplusllc/harness build          # tsc -b
pnpm -F @devplusllc/harness typecheck      # tsc -b --noEmit
pnpm -F @devplusllc/harness check:layout   # validates pkg+templates + scans for banned project names
pnpm -F @devplusllc/harness smoke:mirror   # ephemeral bare-origin + user-tree round-trip
pnpm -F @devplusllc/harness smoke:watch    # daemon programmatic; manifest + decisions ledger update on file events
pnpm -F @devplusllc/harness smoke:mcp      # InMemoryTransport client/server; all 17 tools exercised
pnpm -F @devplusllc/harness smoke:discord  # stub-adapter contract: ingest events → inbox JSON; outbound calls recorded
```

Run all seven before doing anything that mutates `harness/src/` or `harness/templates/`.

The Discord adapter is real code (`harness/src/frontend/discord/`); it is not exercised in CI/smoke because live exercise needs `DISCORD_BOT_TOKEN`. Live wiring confirmed against guild `1487133145013944443` during Phase 5 acceptance: bot connects, 13 slash commands register, the three category channels (`📋 backlog`, `🟢 active`, `📦 archive`) are ensured.

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
│   └── frontend/        adapter contract (types.ts: FrontendAdapter,
│                        FrontendTask/VoiceMessage/SlashEvent/FreeTextEvent/
│                        InteractionEvent/DialogSpec/ApprovalBundle), inbox.ts
│                        helper (writes `.harness/inbox/<ts>-<source>-<kind>-
│                        <slug>.json`), stub/ in-memory adapter for tests,
│                        discord/ real adapter (acl, classifier regex stub,
│                        slash command builders, channels lifecycle, index
│                        DiscordFrontendAdapter)
├── scripts/
│   ├── check-layout.ts  Phase 1 sensor — also scans pkg/templates for banned
│   │                    "mypal" strings (project-agnostic check per L50, S1)
│   ├── setup-mirror.ts  adoption helper: detects origin from cwd, derives slug
│   │                    from package.json `name`, calls ensureMirror
│   ├── smoke-mirror.ts  Phase 2 acceptance
│   ├── smoke-watch.ts   Phase 3 acceptance
│   ├── smoke-mcp.ts     Phase 4 acceptance
│   └── smoke-discord.ts Phase 5 acceptance (stub adapter; live wiring needs
│                        DISCORD_BOT_TOKEN)
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

Phases 6–18 from `docs/INTEGRATION_PLAN.md`. In particular:

- **No Whisper voice transcription.** The Discord adapter detects voice attachments and drops `voice` inbox rows, but transcription is Phase 6.
- **No real Tier-0 classifier.** Phase 5 ships a deterministic regex stub at `harness/src/frontend/discord/classifier.ts` — same return shape as the future Ollama path. Replace in Phase 6.
- **No spec tightener (Layer F).** No model client. No Ollama integration. No Claude/Codex SDK calls.
- **No orchestrator.** Inbox rows pile up; nothing consumes them. `harness run` brings up adapters and idles.
- **No sensors execution.** The sensor catalog at `templates/.harness/config/sensors.yaml` is data; the runner that invokes them is Phase 9.
- **No reviewer subagent / UAT runner / GC cron / backprop / decision capture flow.** Phases 10–14.
- **No init script.** `harness init` is a stub; Phase 16.

The `harness watch`, `harness mirror`, `harness mcp serve`, and `harness run` CLIs work today.

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

Phases 0–5 are landed. Next is **Phase 6 — Whisper voice ingress** (`docs/INTEGRATION_PLAN.md` §5 Phase 6; ~1 founder-day).

Phase 6 deliverables:

1. **Whisper integration** via `smart-whisper` (already in deps) + whisper.cpp via Homebrew. Model `large-v3-turbo` Q5_0 stored at `~/.local/harness/models/`. Audio NEVER written to disk — pipe Discord attachment buffer through ffmpeg → 16k mono PCM → smart-whisper.
2. **Discord adapter wiring** — extend `harness/src/frontend/discord/index.ts` `handleMessage` voice path: instead of just dropping a `voice` inbox row, fetch the attachment buffer, transcribe, drop a `task`/`free_text` inbox row with the transcript and `avg_logprob`. Below `confidence_floor` (default 0.85, configurable in `workflow.md` `voice:` block) → reply "Heard: '...' — confirm?" with 🟢/🔴 buttons before dispatching.
3. **Real Tier-0 classifier** — replace the regex stub in `harness/src/frontend/discord/classifier.ts` with an Ollama call (`OLLAMA_HOST` env + `llama3.2:3b` model). Same return shape (`{ intent, confidence }`). Below confidence threshold → escalate to Tier-1 Haiku.
4. **Smoke acceptance** — record a known voice note, send via Discord, assert transcript matches within Levenshtein 5; assert avg_logprob > 0.85 on clear speech.

Phase 6 prerequisites the operator may need to provide:

- Homebrew-installed `whisper.cpp` (Phase 6 init script handles it; manual fallback: `brew install whisper-cpp`).
- Ollama installed locally (init script Phase 16 handles it; manual: `brew install ollama && ollama pull llama3.2:3b`).
- A short test voice clip for the smoke acceptance.

Do NOT start Phase 6 until the operator says "go". Confirm what's landed first; ask whether to proceed.

## 11. How to start a fresh session

```
1. Read this RESUME_PROMPT.md fully (esp. §1A — implementation snapshot).
2. Read docs/PRIMER.md fully.
3. Skim docs/WORKFLOW_GUIDE.md §0 (adapter contract) + §3 (slash surface) +
   docs/INTEGRATION_PLAN.md §5 Phase 5 (Discord ingress) — that's what's next.
4. Run the six sensors to confirm nothing has broken:
     pnpm -F @devplusllc/harness build typecheck check:layout
                                       smoke:mirror smoke:watch smoke:mcp
   All six should print OK.
5. Confirm to operator in 2-3 lines, e.g.:
     "Resumed Harness project. Phases 0–4 landed (commits d011463, ce30537,
      96b2fa7, c665fce). All six sensors green. Ready for Phase 5 (Discord
      ingress). Need DISCORD_BOT_TOKEN for live exercise; otherwise will land
      stub-adapter smoke. Proceed?"
6. Wait for direction. Don't propose anything beyond what's in INTEGRATION_PLAN.md
   §5 Phase 5.
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
