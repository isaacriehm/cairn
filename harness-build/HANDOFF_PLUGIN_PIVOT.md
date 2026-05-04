---
type: handoff
generated: 2026-05-04
purpose: Export of in-flight work from prior Claude Code session — prep for plugin-form-factor pivot
---

# Handoff — Plugin pivot

> Hi, fresh Claude Code session. The prior session ended after a deep review pass + a UX-philosophy realignment. Read this top-to-bottom before doing anything. Then propose a path forward; do not start coding until the operator confirms direction.

## TL;DR

1. A deep review pass over Tasks A–F + Phase 6 ingestion shipped two real fixes (status.json baseline write + `harness attention` command) and one polish (doctor surfaces attention count). All committed-pending in working tree.
2. The operator then corrected my mental model: **harness is invisible infrastructure**. Operators must NOT type CLI subcommands as ongoing UX. Surface only via inline A/B/C pop-ups inside the Claude Code session.
3. Operator asked: "Can we not build a Claude Code plugin?" — yes, that is the right form factor. We are about to pivot harness from "npm package + CLI" to "Claude Code plugin (hooks + MCP + skills + slash commands)".
4. **Open question for the operator:** spec-first vs prototype-first vs both. They have not picked. Do not start coding the plugin until they pick.

## Project context

Read these in order:

1. `AGENTS.md` — TOC for the project
2. `docs/ARCHITECTURE.md` — locked layered model (harness-core / harness-runtime / harness-frontend-discord / harness-frontend-stub)
3. `docs/PRIMER.md` — concepts + anti-patterns
4. `harness-build/BUILD_LOG.md` — every task's entry; bottom = most recent. The "Deep review pass [DONE 2026-05-04T18:30]" entry summarizes what just shipped.
5. Memory: `~/.claude/projects/-Users-user-Documents-DevPlus-LLC-06---Projects-Harness/memory/MEMORY.md`. The entry titled "Harness UX is invisible infrastructure" is load-bearing — read its body in full.

## Operator profile (do not violate)

- Terse-direct. Lead with answer/action. No filler. No pleasantries.
- Caveman ultra mode for chat replies (active by default; `stop caveman` reverts). Documents in full English.
- Hates env vars. Hates backwards-compat shims. "Tests are shitware. Only E2E with real DB matters."
- Decisions are fast-intuitive — don't present options unless explicitly asked. When operator states a decision, treat as final.
- AskUserQuestion options get truncated on mobile — fall back to A/B/C/etc. with concise option labels in chat.

## What just shipped (uncommitted, in working tree)

Branch: `main`. Status:

```
M harness-build/BUILD_LOG.md
M harness/package.json
M harness/src/cli/index.ts
M packages/harness-core/src/doctor/index.ts
M packages/harness-core/src/init/index.ts
M packages/harness-core/src/init/init.ts
M packages/harness-core/src/session-start/build.ts
M packages/harness-core/src/status-line/writer.ts
?? harness/scripts/smoke-ingestion-baseline.ts
?? harness/src/cli/attention.ts
?? packages/harness-core/src/init/baseline-audit.ts
?? packages/harness-core/src/init/ingest-docs.ts
```

Everything compiles clean (`tsc --noEmit` both packages) and all 6 smokes pass:

- smoke-session-start (8/8)
- smoke-status-line (4/4)
- smoke-handoff (3/3)
- smoke-scope-index (3/3)
- smoke-read-enrich (4/4)
- smoke-init (zero JSON in stdout)
- smoke-ingestion-baseline (4/4)

### Fixes shipped this session

1. **`ctx:0/0` bug fix.** `defaultStatusJson` had `ctx_tokens_budget: 0` → bumped to 4000. Init Phase 5c now writes baseline `status.json` via `writeStatusJsonForSlug(slug, defaultStatusJson(false))` BEFORE calling `tryStartDaemon`. Post-Phase-6 patches `attention_count = drafts + baseline_findings` when daemon did not start. Caveat from realignment: status line is health indicator, not diagnostic. So this fix is "good enough for now" but the whole status-line surface should be rethought once the plugin pivot lands. Don't over-invest in status line polish.

2. **`harness attention` CLI added.** New `harness/src/cli/attention.ts` reads `.harness/ground/decisions/_inbox/*.draft.md` + latest `.harness/baseline/sensor-audit-*.yaml`. Wired into root CLI. **This is the wrong long-term shape per the realignment** — operators should NOT type `harness attention`. The CLI exists as a debug surface; the real UX is inline A/B/C in Claude Code (see plugin pivot below). Do not invest more in the CLI form.

3. **Doctor surfaces attention.** `checkDaemonStatus` appends `, attention:N` to the daemon row when `attention_count > 0`, with `fixCommand: "harness attention"`. Same caveat — debug surface only.

### Phase 6 ingestion + first-session onboarding

Both already shipped (prior session, see BUILD_LOG entry "Phase 6 — Initial ingestion sweep [DONE 2026-05-04T18:30]"). Verified working via smoke-ingestion-baseline. No fix needed.

- `init/ingest-docs.ts` — Haiku-classifies docs into DEC drafts / canonical-map entries / voice.md update
- `init/baseline-audit.ts` — runs every runnable sensor against the full codebase, writes `.harness/baseline/sensor-audit-<ISO>.yaml`
- `session-start/build.ts:renderFirstSessionOnboarding` — fires when 0 decisions / 0 invariants / baseline audit yaml present; suppressed once first DEC is accepted

## The realignment

Operator stated:

> Harness is supposed to just handle everything without the user doing anything. The user should be able to just go into Claude code and be able to prompt normally and do their normal workflow without doing anything special. The UI for the user should purely just be if Harness needs something, we prompt the user in the Claude code terminal. But I don't want it to be like a text prompt. I want it to, like, pop up and have the user handle it. In a simple way like a b c and button clicking, not complex state management shit where they have to worry about if it's working or not.

Saved to memory as `feedback_harness_invisible_infra.md`. Read it.

**Implications:**

- CLI subcommands are NOT the ongoing operator UX. Only `harness init` (one-time bootstrap) is acceptable as an operator-facing CLI.
- `harness attention` / `harness doctor` / `harness configure brand` / etc. should retire as operator-facing UX. They can exist as MCP tools / debug entrypoints called by the plugin's skills / hooks.
- Status line is for HEALTH (alive ● / down ○), not for diagnostics the operator is supposed to read.
- When harness needs operator input → inline pop-up A/B/C picker in the Claude Code terminal, surfaced by the plugin's skill calling Claude Code's built-in `AskUserQuestion` tool. Operator clicks; skill calls a harness MCP write tool with the choice; harness updates state. Operator stays in their normal flow.

## The plugin pivot (proposed; awaiting operator confirm)

Harness becomes a Claude Code plugin. Bundle:

- **MCP server** — existing `harness_decision_get` / `harness_decisions_in_scope` / `harness_invariant_get` / `harness_canonical_for_topic` / `harness_get_full` / `harness_search` / `harness_query_history` / `harness_record_decision` / `harness_archive` / `harness_append_run_note`. Add new write tools for inline-prompt resolution: e.g. `harness_resolve_attention(item_id, choice)`.
- **Hooks** — `SessionStart` (existing context inject), `PostToolUse` on Read/Write/Edit (existing read-enricher + write-guardian).
- **Skills** — `harness-attention` skill that auto-invokes when SessionStart context flags pending items. Skill calls `AskUserQuestion` to render A/B/C picker, relays choice via `harness_resolve_attention` MCP tool. Possibly `harness-direction` skill for capturing decisions inline.
- **Slash commands** — `/harness-init` to bootstrap a new project (replaces or supplements the `harness init` CLI).
- **Settings** — auto-wires hooks + MCP server registration. Plugin install = adoption is now `claude plugin install harness` once at user level, then opening Claude Code in any repo activates harness.

### Adoption flow under the plugin model

1. `claude plugin install harness` (once, user level).
2. Operator opens Claude Code in a repo.
3. Plugin SessionStart sees no `.harness/` → skill renders A/B/C: "Adopt this project with harness? [a] yes [b] not now [c] never". Operator picks. On `a`, skill orchestrates init via MCP tools — no CLI dance.
4. After adoption, plugin runs invisibly. Surfaces A/B/C only when blocked (pending DEC drafts, baseline findings, drift remediation, brand setup).

### Architectural questions to answer in the spec

- Where does plugin live? `packages/harness-plugin/` as a new pnpm workspace, OR retire `packages/harness-core` CLI surface and embed in plugin directly?
- How does the plugin install MCP server config? Via plugin manifest, or does the plugin bundle the MCP server binary?
- The `harness daemon` (FIFO queue + sensor sweep + nightly GC) currently lives in `harness-runtime`. Does it stay as a separate process auto-started by the plugin, or migrate inside?
- How does adoption bootstrap work via skill? (Init mapper is a long-running Sonnet call — the skill needs to surface progress while it runs.)
- Migration: keep `harness init` CLI during transition? Hard cutover (operator hates backcompat shims)?

## Open question — operator picks before any code

- **a)** Spec-first. No code. Write `docs/PLUGIN_ARCHITECTURE.md` covering: plugin layout, hook/skill/MCP wiring, inline-prompt protocol, adoption flow, migration path, what gets retired vs kept.
- **b)** Prototype-first. Scaffold `packages/harness-plugin/` + ship one inline-attention flow end-to-end (SessionStart sees pending DEC drafts → skill renders A/B/C → MCP tool resolves). Validates the architecture before spec.
- **c)** Both. Spec first, then prototype.

## What NOT to do

- Do not invest more in `harness attention` / `harness doctor` / `harness configure` CLI surfaces. They are debug-only.
- Do not invest more in status-line diagnostic readouts (`ctx:N/N`, `decisions:N`). The status line is just health.
- Do not start coding the plugin until the operator picks a / b / c.
- Do not commit the uncommitted working-tree changes without confirming with operator. The fixes are sound, but commit timing is operator's call.
- Do not propose alternative libraries / frameworks unless they avoid real risk. Tech stack is opinionated.

## Useful runtime checks

```bash
# Compile gate
cd packages/harness-core && npx tsc --noEmit
cd harness && npx tsc --noEmit

# Smoke suite
cd harness
pnpm smoke:session-start
pnpm smoke:status-line
pnpm smoke:handoff
pnpm smoke:scope-index
pnpm smoke:read-enrich
pnpm smoke:init
pnpm smoke:ingestion-baseline

# JSON log leakage check
pnpm smoke:init 2>&1 | grep -cE '"level":|"time":|"pid":'    # must be 0

# Verify new attention CLI works
npx tsx harness/src/cli/index.ts attention --help
npx tsx harness/src/cli/index.ts attention --repo /tmp/no-such-dir   # exit 2
```

## First reply to the operator

Open with: "Loaded. Read prior session's handoff." Then summarize in 2–3 sentences what is in flight (plugin pivot, awaiting a/b/c on direction). Then ask which of a / b / c they want. Do not start coding until they answer.
