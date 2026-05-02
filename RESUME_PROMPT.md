---
type: resume-prompt
status: handoff
audience: ai-only
generated: 2026-05-02
purpose: Drop into a fresh Claude Code session in /Users/user/Documents/DevPlus LLC/06 - Projects/Harness to continue this project where the previous session left off.
---

# Resume Prompt — Harness Project

You are a freshly-spawned agent picking up an in-flight project. Read this file end-to-end before doing anything. Then read `docs/PRIMER.md`. Then confirm to the operator what you've loaded.

## 1. Mission

Build a **portable, generic agent harness for solo developers**. Discord-front-ended. Local Whisper voice input. Filesystem-only state. Honest-agent invariants stack. Direct-commit workflow. Symphony-shaped per OpenAI's open-source spec.

Mypal (a real-estate CRM at `/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`) is the proving ground. The harness package extracts cleanly to any other project via `npx @devplusllc/harness init <repo-dir>`.

**Status:** design phase. No code yet. Documentation in `docs/` is the source of truth.

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

Based on the conversation trajectory:

1. **Read the docs.** Operator has not yet read v2. Likely first action when they pick up: skim `PRIMER.md`, `INTEGRATION_PLAN.md`, the new `WORKFLOW_GUIDE.md`. Probably leaves `MCP_SURFACE.md` and `FILESYSTEM_LAYOUT.md` for later (reference docs).
2. **Codex peer review pass.** Operator plans to feed `docs/CODEX_REVIEW_BRIEF.md` to a Codex session for an independent design audit. Treat Codex's findings as authoritative for the items it flags; fold into the docs (no defensive responses). Disagreements get preserved as `disagreement` blocks. Loop until both feel build-ready.
3. **Confirm or adjust the locked decisions.** Operator may have second thoughts on a handful. Treat any disagreement as a single change to the doc set, not a rewrite.
4. **Resolve open items in `QUESTIONS.md`.** Most defaults are now locked; only a few residuals remain (Discord guild + owner ID; optionally Notion DB ID + owner if Notion adapter wanted at v0).
5. **Start Phase 0** of `INTEGRATION_PLAN.md` (workspace bootstrap) once the operator gives the go.

Do NOT start coding until the operator says "go" or explicitly directs you to begin a phase. The current phase is **review-the-design**.

## 11. How to start a fresh session

```
1. Read this RESUME_PROMPT.md fully.
2. Read docs/PRIMER.md fully.
3. Skim docs/INTEGRATION_PLAN.md, docs/WORKFLOW_GUIDE.md, docs/QUESTIONS.md.
4. Confirm to operator in 2-3 lines:
     "Resumed Harness project. Design phase. PRIMER + 6 supporting docs ready.
      [N] decisions locked. [N] residual questions in QUESTIONS.md. What next?"
5. Wait for direction. Don't propose a next step beyond what's already in INTEGRATION_PLAN.md.
6. Caveman ultra mode active throughout. Match operator's terse-direct style.
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
