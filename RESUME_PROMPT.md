---
type: resume-prompt
status: rework-brief
audience: ai-only
generated: 2026-05-03
purpose: A fresh agent picking this up should NOT continue building phases. Read this brief, read the docs, then help the operator FIX what was built. The existing code passed its smokes but the integrated experience is broken: shallow init, opaque runs, un-steerable mid-flight, terrible UX. Stop adding. Start fixing.
---

# Resume Prompt — Harness Rework Brief

You're picking up an in-flight project that **shipped a lot but doesn't work as a system**. Phases 0–16.3 landed (commits in `git log --oneline`). Each smoke passed. The operator just ran the harness against their real project and called it a "MASSIVE FAIL across the entire board." This brief exists so you don't repeat the mistake of the prior session: chasing phase-completion smokes while the actual operator experience rots.

Read this file end-to-end. Then read `docs/PRIMER.md`, `docs/INTEGRATION_PLAN.md` §16, and `docs/WORKFLOW_GUIDE.md`. Then confirm to the operator what you've loaded and propose the fix order.

## 1. What's actually broken (operator's verdict)

Quoted directly from the operator after running the harness against `mypalcrm`:

> "I'd say this is a MASSIVE FAIL across the entire board, the UX is terrible, the functionality is terrible, the user is left in the dark and cant steer, so many problem. The whole init thing isnt doing the pre-setup it should with the data mining, the docs/ laid out better than it was coded."

The four named failures, decomposed:

### 1.1 Init is shallow

The init wizard at `harness/src/init/` does **stack-signature detection and sensor proposal**, then seeds templates and sets up a mirror. Per `docs/INTEGRATION_PLAN.md` §16.2 line 471, init was supposed to also dispatch a **Tier-2 LLM mapper agent** that:

- Walks the repo using profile-aware canonical-path rules
- Inventories canonical paths
- Proposes the pilot module
- Proposes the project-specific sensor list (beyond the generic stack-detected ones)
- Proposes off-limits paths (beyond the generic node_modules/dist defaults)
- Proposes the initial `WORKFLOW.md` body's `<project_name>:` extension block (route_handler_globs, dto_globs, generator_source_globs, high_stakes_globs)

None of this exists. The current init writes empty arrays for `project_globs.*` in `.harness/config.yaml` and skips the mapper entirely. So the orchestrator runs against a project it has never read.

The `init_mapper: 2` slot in `templates/.harness/config/workflow.md` was meant to hold this dispatch; it's referenced but never invoked.

### 1.2 Runs are opaque

The Tier-0 activity feed (`harness/src/orchestrator/activity-summarizer.ts`) was supposed to surface "what the agent is doing right now" via Ollama llama3.2:3b. It does fire on an 8s cadence but:

- The activity field renders inside an embed; Discord caches embeds aggressively and the visual update is sluggish
- The first summary takes 5s + ~200ms Ollama latency, so for short tool calls the operator never sees that step
- Ollama failure silently falls back to "Working…" — there's no second-source visibility (e.g. recent file edits surfaced from the events log directly)
- The events.jsonl file has FAR more structured data than the summary captures (file paths edited, bash commands run, search patterns) — none of it surfaces structurally; only the LLM summary

The operator is asked to TRUST the orchestrator for 60-300s with at most a sentence-per-8s of vague "Reading X" updates.

### 1.3 Operator can't steer mid-run

Per `docs/WORKFLOW_GUIDE.md` §3, the documented slash surface includes `/halt`, `/status`, `/oops`, `/queue`, `/eval`, `/resume`, `/archive`. Of these, NONE are wired except the existing `/task` and `/direction` from earlier phases. The operator can:

- Submit a task ✓
- Walk per-Q tightener dialog ✓
- Approve UAT bundle ✓
- Click ship-anyway / cancel on tightener fail ✓

The operator CANNOT:

- Pause an active run
- Cancel an active run
- Check what's currently running without scrolling Discord
- Inspect the queue
- Re-prioritize tasks
- Roll back a recent commit
- Inject a hint or correction mid-run

`harness_ask_operator` (Phase 16.3) adds AGENT-initiated questions, but the operator still can't proactively reach in. This is backwards — the operator is the one who knows when something's going wrong.

### 1.4 Discord UX feels broken

Operator's wrapper-up frustration was specifically about UX. Concrete defects observed:

- Initial task drop message and the live status embed are separate messages (predates the embed-everywhere commit on the operator's instance, but the architecture still creates them as two posts even after `f332544`)
- Per-Q walks created N+1 messages (4 questions + 1 confirm), filling the channel
- Approve-button reactions worked but the button-press → run-resumes loop took 60+ seconds with no visible signal except a phase color change
- Failure surfaces (sensor / reviewer fails) eject the run with a one-line embed and no remediation guidance to the operator
- Stale tasks from `_queue.yaml` with deleted channels burned LLM quota every restart until preflight-channel-check landed in `eb41191`

## 2. What the docs specified vs what was built

| Doc spec | What exists in code | Gap |
|----------|---------------------|-----|
| Init mapper (Tier 2 LLM) walks repo, proposes pilot module + project_globs + off-limits + WORKFLOW.md body (`INTEGRATION_PLAN.md` §16.2 line 471) | `harness/src/init/detect.ts` does stack-signature + sensor proposal; no mapper | **Mapper agent never built** |
| Stack profiles with canonical-path rules, generator commands, high-stakes defaults (`INTEGRATION_PLAN.md` §16.1) | Operator told me to drop profiles. I dropped them entirely. | **Overshot.** Profiles for canonical-path / generator / high-stakes defaults still needed even with detection-driven adoption |
| `/halt`, `/status`, `/oops`, `/queue`, `/eval`, `/resume`, `/archive` slash commands (`WORKFLOW_GUIDE.md` §3) | Only `/task`, `/direction`, `/ship-anyway` exist | **6 slash commands missing** |
| Pre-run cost projection (>1% daily plan-headroom prompts operator) (`WORKFLOW_GUIDE.md` §2.2) | Not implemented | **Missing** |
| Plan-quota monitor + auto Tier-1-only throttle when <20% remaining (`WORKFLOW_GUIDE.md` §2.2) | Not implemented | **Missing** |
| `/oops` conversational dialog (`WORKFLOW_GUIDE.md` §4.1) | Not implemented | **Missing** |
| `/status` returns running task, queue depth, recent runs, eval, weakest module (`INTEGRATION_PLAN.md` §17) | Not implemented | **Missing** |
| Pino logs to `.harness/runs/<id>/log.jsonl` (`INTEGRATION_PLAN.md` §6.2) | Logs go to pino stdout only; no per-run log.jsonl | **Per-run log file missing** |
| Discord thread per run (operator-visible) (`INTEGRATION_PLAN.md` §6.2) | Each run gets a CHANNEL not a thread; threads would scope better | **Channel-per-task chosen instead — review whether thread-per-task is the right shape** |
| `quality-grades.yaml` for module-health surface (`INTEGRATION_PLAN.md` §6.2) | File generated by GC; never surfaced to operator | **Surface missing — `/status` would render this** |
| Init script E2E `now` actually runs setup commands | Phase 16.1 fixed this | ✓ landed |
| Init uses inquirer not hand-rolled prompts | Phase 16.0→16.1 swap | ✓ landed |
| Operator-visible "what's the agent doing" during run | Tier-0 activity feed (16.2) | ⚠ partially — summary is vague, no structured events surface |

## 3. Reset path — what to fix and in what order

Stop building forward. The next session should EXECUTE the fixes below; do not start Phase 17 / 18 / trial pilot until 3.1 through 3.4 are landed, smoke-tested, AND integration-tested against `mypalcrm`.

### 3.1 Init mapper agent (the missing 70% of init)

**Highest priority.** Without this, the harness runs blind against the project. `.harness/config.yaml` has empty `project_globs` so route-handler / DTO / decision sensors don't fire on real diffs.

Build in `harness/src/init/mapper.ts`:

- Walks the repo respecting `.gitignore`, capping depth at 4-5 levels and total-file count
- Builds a structural summary (top-level dirs, package layout, key file types, frameworks detected from imports/configs)
- Sends this summary to a Tier-2 (Sonnet) `claude --print --json-schema` call with structured output:
  - `pilot_module` (suggested initial scope)
  - `route_handler_globs[]` (file glob patterns where HTTP/CLI handlers live)
  - `dto_globs[]` (DTO/schema files)
  - `generator_source_globs[]` (e.g. drizzle schema, openapi spec)
  - `high_stakes_globs[]` (auth, billing, multi-tenant data flows)
  - `off_limits_globs[]` (vendored code, generated artifacts, third-party)
  - `domain_summary` (one-paragraph description of what the project does)
  - `key_modules[]` (each with name + path + purpose)
  - `proposed_sensors[]` (project-specific sensors beyond stack-detected: ORM-level / framework-level)
- Operator confirms via inquirer `confirm`/`edit` per the docs
- Approved output writes into `.harness/config.yaml` (project_globs filled) AND `.harness/config/workflow.md` `<slug>:` extension block

This is the **deep mapper** the docs promised. Budget: ~$1-3 per adoption, one-time. Tier 2 per `init_mapper: 2`.

### 3.2 Operator-steering primitives

Six slash commands per `WORKFLOW_GUIDE.md` §3:

| Command | Implementation |
|---------|---------------|
| `/halt [run-id]` | Kill the active claude subprocess (SIGTERM + 30s grace + SIGKILL); orphan-process scan on harness restart. Mark run as `aborted`. |
| `/status` | Return queue depth, running task id + phase + activity, last 5 runs (id + status + duration), GC age, plan-quota headroom |
| `/queue` | Render the FIFO queue + per-task channel links |
| `/oops` | Multi-step dialog per `WORKFLOW_GUIDE.md` §4.1 — captures stub-pattern additions, doc-staleness signals, sensor false-positives |
| `/eval [scope]` | On-demand sensor sweep without dispatching an implementer |
| `/resume <run-id>` | Re-attach a UAT bundle's approval dialog after operator was AFK |

These need adapter contract additions (`adapter.handleSlash` is already there; just register more commands). Discord `slashCommandBuilders` array needs new entries.

### 3.3 Run visibility

Three concrete wins:

1. **Per-run log.jsonl mirrored in channel** — write a structured log alongside events.jsonl (run started, phase changed, sensor-id+result, reviewer verdict, UAT decision). Periodically tail the last N entries into the live status embed's description (replacing the static "phase: running" line) so operator sees ACTUAL progress.

2. **Structured event surfacer** — directly extract from events.jsonl: list of files edited (deduped), bash commands run, search patterns. Render as a fixed-format embed FIELD that updates alongside the Tier-0 activity field. This is the second-source visibility that doesn't depend on Ollama.

3. **Drop the live-edit + post-content split** — when a content body needs to surface (tightener feedback, reviewer rationale), append it as a FIELD on the live status embed (up to 1024 chars), don't post a separate message. Keeps the channel minimal.

### 3.4 UX cleanups

- Make the per-Q walk one composite message that edits in place (Q1 → Q2 → Q3 → confirm), not N separate posts
- When a run fails (sensors / reviewer / UAT), show a remediation embed with: failure reason + last 3 events from the agent + suggested next action (re-run with /ship-anyway / re-submit with edits / open a thread for discussion)
- Fail-button states the actual class: 🟧 sensor-fail, 🟪 reviewer-fail, 🟦 UAT-rejected, 🟥 hard-error — operator can route differently per class

### 3.5 Defer until 3.1–3.4 are landed

- Phase 15 trial-run pilot (the integration test of all the above)
- Plan-quota monitor + cost projection (tactical; build after the structural fixes)
- `/archive` slash (non-critical)
- Multi-adapter routing (only matters when Notion adapter exists)
- Voice variant of /direction (covered in earlier phases; verify still works after 3.1)

## 4. Locked architectural decisions still hold

Do NOT redo the harness from scratch. The following are correct and shouldn't be reopened:

| # | Decision | Reason it holds |
|---|----------|-----------------|
| L01 | TypeScript-first stack | Operator's primary language |
| L02 | pnpm monorepo workspace package (`harness/`) inside the repo | Adopters get it via `pnpm dlx --package <local-path>` or eventual `npx @devplusllc/harness` |
| L03 | Filesystem-only state | Operator's preference; visible, version-controlled |
| L04 | Two-zone canonical/historical separation | Stale never sits next to live |
| L05 | Direct commits to `main`, no branches/PRs (solo mode) | Operator preference |
| L06 | Parallel mirror checkout at `~/.local/harness/repos/<slug>/` | User's working tree is sacred |
| L07 | Concurrency = 1 (single-task FIFO) | Operator works sequentially |
| L08 | Frontend adapter is pluggable | Discord is default; Notion / CLI / web adapters are peers |
| L09 | Channel-per-task with category lifecycle (📋 backlog / 🟢 active / 📦 archive) | Visible state at a glance — but reconsider channel-vs-thread per §3 |
| L10–L12 | Local Whisper for voice (whisper.cpp + smart-whisper, audio never on disk) | TS-everywhere; Metal+CoreML on M-series; PII risk avoided |
| L13 | Squares-into-square-holes UX (A/B/C/D dialogs) | Operator preference |
| L14 | Tier ladder (0/1/2/3 → Ollama / Haiku / Sonnet / Opus) | Cost discipline |
| L15 | Reviewer subagent uses SAME model as implementer, fresh context | Context isolation catches blindspots |
| L16–L18 | Auto-merge classes (safe / code / high-stakes) | Risk-stratified gating |
| L19 | Backprop protocol (every fix → §V invariant + sensor) | Repeats become preventable |
| L20 | GC cadence (nightly background drift sweep) | Continuous curation |
| L21 | `AGENTS.md` = TOC pattern, ~150 lines max | Progressive disclosure |
| L22 | All operator I/O multiple-choice-first | Free-text only as escape hatch |
| L23 | Voice-note rejection on UAT 🔴 → Whisper transcribes the rejection reason | Same pipeline both ways |
| L24 | `/ship-anyway` operator override | For trivial cases or sensor false-positives |
| L25 | Stub-pattern catalog (Layer A) grows via `/oops` dialog only | No CLI commands |
| L26 | Decision assertions are machine-readable (11 kinds) | Mechanical evaluation |
| L27 | Decision capture flow — Discord 🟢-confirm at confirm-time | Decisions survive across runs |
| L28 | No phase-gates between modules | Harness adopts modules as operator opts in |
| L29 | Snapshot pinning per run (origin/main SHA at start) | Eliminates "wait what changed?" |
| L30 | MCP retrieval is structured graph traversal | Deterministic |
| L31 | Append-only writes via MCP | Saves N file reads per write |
| L32 | Custom sensor remediation messages — agent-prompt-shaped | Per OpenAI pattern |
| L33 | Evidence-file gate (`.uat-passed` SHA256) | Bare touch rejected |
| L34 | Provenance frontmatter required on canonical zone load-bearing markdown | Staleness detection |
| L35 | Stale doc lifecycle = MOVE not flag | Move to `.archive/<date>/<original-path>` |
| L36 | Generic harness pkg + per-project `.harness/config.yaml` | Portable |
| L37 | `npx @devplusllc/harness init` runs deep mapper (Tier 2 LLM, one-time) | **THIS IS THE GAP. §3.1 fixes it.** |
| L38 | Ollama for cheap classification | $0 Tier 0 |
| L41 | Decision-assertion DSL (11 kinds incl. behavioral) | Per Codex audit |
| L42 | Budget metric is Claude Code coding-plan quota, NOT $/day | Per operator answer T1 |
| L43 | High-stakes UAT MUST include cross-tenant negative fixture | Per Codex audit |
| L44 | Operator dialog cap: 2 questions per turn | Per Codex audit |
| L45 | Pre-dispatch + pre-push `local_dirty_overlap` gate | Per Codex audit |
| L46 | GC batch canary | Per Codex audit |
| L48 | `collaboration_mode: solo \| team` config | Per Codex audit |
| L49 | Distribution mechanism for early testers | Private GitHub repo / tarball / symlink-clone |
| L50 | Project-agnostic harness pkg code (no hardcoded project names) | Per operator answer S1 |

L47 (stack profiles for portability) was OVER-corrected. Re-introduce profiles ONLY for canonical-path detection and generator commands; everything else stays detection-driven. Operator's "agnostic" objection was about hardcoded behavior, not about reusable adoption-time templates.

## 5. Operator profile (binding)

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. Lead with answer/action. No filler. |
| Decisions | Fast-intuitive. Don't present options unless explicitly asked. When operator states a decision, treat it as final. |
| Explanations | Concise. Root cause in 1-2 sentences then fix. |
| UX Philosophy | Design-conscious. UX equal in importance to functional correctness. |
| Vendor Choices | Opinionated. Do not suggest alternative libraries/frameworks unless they avoid real risk. |
| Env vars | Hates env vars. Quote: *"I hate env vars, it's more moving pieces, the only thing that should be stored in env is stuff that might change, like brand domain, secrets, etc."* Hardcoded model IDs in code = correct. |
| Tests | *"Tests are shitware, the only tests that matter truly is E2E with real db."* Drop test framing entirely. Sensors and E2E real-DB only. |
| Backward compat | *"We DO not care about legacy or backward compat, we are very early in development."* Hard cutovers. No transition shims. |
| AI features | AI is the platform. Default tilt: implement, not strip, when uncertain. EXCEPT when AI is misaligned product debt — then strip without hesitation. |
| Frustrations | Instruction-adherence. Follow exactly. Don't add framing/features they didn't request. Never report done unless fully satisfies criteria. |
| Mobile mode | When operator is on mobile, `AskUserQuestion` options get truncated. Switch to chat-mode K/R/U/M with concise option labels. |
| UX rule (load-bearing) | Squares-into-square-holes. Always propose A/B/C/D before asking for typed input. Free-text only as escape (`E) Other`). |
| Inquirer | Use `@inquirer/prompts` for harness CLI dialogs, NOT hand-rolled readline. Operator note 2026-05-02 + correction 2026-05-03 after I substituted hand-rolled. |

Caveman ultra mode is active for chat replies. Output format = `[thing] [action] [reason]. [next step].` Drop articles, filler, pleasantries. Fragments OK. Code/commits/PRs/documents written normal full English.

## 6. What landed in the codebase (so you don't redo it)

The git history is authoritative. Before doing anything: `git log --oneline | head -30` and read each commit's first-line summary. As of this writing the recent runway is:

- `16ea9ab` — RESUME_PROMPT update for 16.2/16.3 (THIS FILE supersedes that)
- `a66bfaf` — `harness_ask_operator` MCP tool + queue-restore inbox-file check
- `f332544` — embed-everywhere + Tier-0 activity feed
- `4e17fea` — silent ack + answered-question compaction + body chunking
- `eb41191` — abandon stale-channel tasks at dispatch
- `4efaec7` — dead-channel suppression
- `6e3f20c` — dialog buttons stalled when bundleId contains colons (FIX)
- `7ab96a4` — short letter buttons + full text in prompt
- `0b3e6b4` — single edited status + colored embeds + reactions (initial)
- `ad48838` — typing indicator
- `48907b8` — Ambiguity object render (FIX — was [object Object])
- `f92f5a8` — tightener fail → operator dialog (replacing terminal-fail)
- `03208e8` — kill stale "Phase 8 not wired" lie + surface tightener feedback
- `9d842fd` / `3293fe0` / `3c52e37` — Phase 16.x init wizard
- `1486ed0` — Phase 14.x decision-capture refinement
- `f482685` — Phase 14 decision-capture
- `da7e965` — Phase 13 backprop
- `915f358` — Phase 12 GC cadence
- `51916fb` — Phase 11.x UAT rejection / question / live SQL drivers
- `f8f6121` — Phase 11.5 heavy probes
- `bb8dd3f` — Phase 11 UAT pipeline
- `d29ccb3` — Phase 10 reviewer
- `9223ef0` — Phase 9 sensors
- `6c945fa` — Phase 8 orchestrator
- `b730bac` — Phase 7 tightener
- `cdd0f13` — Phase 6 voice + tier-0
- `b5c7420` — Phase 5 Discord ingress
- `c665fce` — Phase 4 MCP server (17 tools — `harness_ask_operator` is the 18th)
- `96b2fa7` — Phase 3 grounding daemon
- `ce30537` — Phase 2 mirror runtime
- `d011463` — Phase 0–1 bootstrap

23 smoke scripts under `harness/scripts/smoke-*.ts`; CLI entries under `harness/src/cli/`; 18 MCP tools under `harness/src/mcp/tools/`; init module under `harness/src/init/`.

The smokes pass individually. The integrated experience does not.

## 7. How a fresh session starts

```
1. Read THIS FILE end-to-end.
2. Read docs/PRIMER.md (concepts + anti-patterns).
3. Read docs/INTEGRATION_PLAN.md §16 (init spec, including the mapper).
4. Read docs/WORKFLOW_GUIDE.md §3 + §4 (slash surface + dialog templates).
5. Skim git log for what landed since the last commit.
6. Run cheap smokes once to confirm tree builds:
     pnpm -F @devplusllc/harness build typecheck check:layout
                                       smoke:mirror smoke:watch smoke:mcp
                                       smoke:discord smoke:tier0 smoke:sensors
                                       smoke:uat smoke:gc smoke:init
7. Confirm to the operator in 3-4 lines:
     "Loaded rework brief. Phases landed but UX broken. Fix order:
      §3.1 init mapper → §3.2 steering slashes → §3.3 visibility → §3.4 UX.
      Start with §3.1?"
8. Wait for direction. Don't propose phases beyond §3 until §3.1–3.4 land.
```

## 8. Things the operator has said (verbatim, load-bearing)

- *"It should feel like Im a baby putting squares into the square hole"*
- *"the end-user Human purely just wants to be able to prompt and have a fully done project spit out"*
- *"if we use Sonnet model to code and Opus to review, we effectively just kill the limits of the coding plan"*
- *"NOTHING should be a stub. This is completely missing functionality from the site."*
- *"I find [branches] as a waste of time, especially since Im the only developer and I only start 1 task and finish 1 task before doing another"*
- *"AIs want UAT testing, however most times Im working im out of the house and cannot access the site"*
- *"the discord part is more of a feature, I have a buddy that likes using Notion so it should be built slightly agnostic"* — drove L08 frontend pluggability
- *"I'd say this is a MASSIVE FAIL across the entire board"* — drove this rework brief

## 9. Anti-patterns to avoid in the rework

Do not:

- Build new phases that smoke-pass in isolation but don't integrate cleanly. Cross-cutting concerns (steering, visibility, UX cohesion) need their own pass.
- Add config knobs as a substitute for fixing defaults. The init should produce a working setup; not a working setup conditional on the operator twiddling 12 yaml fields.
- Treat per-feature smokes as proof of system health. Run the actual end-to-end flow against `mypalcrm` before claiming a fix is complete.
- Continue the "phases landed" narrative if it's not true. The phase-completion accounting hid the fact that the integrated experience had broken months before.
- Substitute hand-rolled logic for libraries the operator has stated they want (inquirer was the prior session's mistake; that guidance is now in `~/.claude/projects/-Users-user-Documents-DevPlus-LLC/memory/`).
- Skip `docs/INTEGRATION_PLAN.md` § references when building. The docs were better than the code; they're authoritative for what the harness should be.

## 10. Tooling notes

- Operator uses Claude Code (Opus 4.7) primarily; sparse Codex usage for second-model audits.
- Operator's adopted-project for testing is `/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`. Mirror at `~/.local/harness/repos/mypalcrm/`.
- Operator's Discord guild ID `1487133145013944443`; bot token + guild ID in `~/.local/harness/.env` (mode 0600).
- Whisper model at `~/.local/harness/models/ggml-large-v3-turbo-q5_0.bin`.
- Ollama with `llama3.2:3b` available locally.
- The harness is invoked via `pnpm dlx --package "/Users/user/Documents/DevPlus LLC/06 - Projects/Harness/harness" harness <subcommand>` until npm-published.

## 11. References (read before fixing)

- `docs/PRIMER.md` — concepts, anti-patterns, glossary
- `docs/INTEGRATION_PLAN.md` — phase-by-phase spec; §16 is THE init source-of-truth
- `docs/FILESYSTEM_LAYOUT.md` — adopted-project layout
- `docs/MCP_SURFACE.md` — MCP tool surface (now 18 tools incl. ask-operator)
- `docs/UAT_PIPELINE.md` — UAT-on-phone via Discord buttons
- `docs/WORKFLOW_GUIDE.md` — operator UX rules + slash surface + dialog templates (§3, §4 are critical for §3.2 in this brief)
- `docs/QUESTIONS.md` — residual open items
- `docs/CODEX_REVIEW_BRIEF_REVIEW.md` — Codex's audit findings (3 must-fix landed via L41/L43–L48)

---

End of rework brief. The harness has the bones; it lacks the connective tissue between adoption (deep mapping) and operation (steering + visibility). Build the connective tissue. Don't add more bones.
