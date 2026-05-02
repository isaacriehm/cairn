---
type: questions
status: draft-v2
audience: dual
generated: 2026-05-02
purpose: Residual open items after the v2 design pass. Most defaults are now locked in PRIMER + INTEGRATION_PLAN + WORKFLOW_GUIDE. Answer these to lock the remaining tactical config.
---

# Residual Questions — Harness Project

Most architectural decisions are locked (see `RESUME_PROMPT.md` §4). What remains here is **tactical config** the harness needs at adoption time.

## How to answer

- Single word / phrase per row.
- `default` accepts the listed default.
- `skip` defers; harness adopts a sensible default and notes it for revisit.
- Free-form for paragraph-style only when prompted.

## Quick-fill block (copy to top of your reply when answering all at once)

```
P1: default  P2: @devplusllc/harness
A1: default  A2: no? we are implementing harness on the full project  A3: yes, but those are stale / canonical, I will get those cleaned up before deployment
F1: discord
G1: default, a middle grounds berween d-e, I want it to be simple  G2: default  G3: obviously slop code will happen, but if harness doesnt catch it, then it defeats the purpose
D1: 1487133145013944443 (mypal. discord)  D2: 1264005138918408204  D3: default  D4: default
N1: ___  N2: ___  N3: ___  N4: ___
S1: the harness should propose sensors, agnostically, like dont mention "mypal." ANYWHERE within harness code, only internal docs. we should ask the user  S2: default
T1: skip, we use coding plans, the only metic that matters is the claude code usage.  T2: Whatever frontend adapter is active
M1: inside this directory, but I need a way to share it with friends for them to test, maybe private repo or some zip file, idk  M2: Yes
```

---

## P. Project skeleton — locked at v2

These were debated and locked. Listed here so you can object if any has drifted.

| #   | Decision                                                | Confirm                                                   |
| --- | ------------------------------------------------------- | --------------------------------------------------------- |
| P1  | Project name `Harness` (capitalized; folder `Harness/`) | default                                                   |
| P2  | Generic package name `@isaac/harness` (npm)             | default — change to `@<your-handle>/harness` if preferred |

## A. Adoption — initial sample project

| #   | Question                                      | Default                                                                                      | Answer |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| A1  | First adopted project for the trial run       | mypal (`/Users/user/Documents/DevPlus LLC/06 - Projects/mypalcrm/`)                          |        |
| A2  | Pilot module within mypal for first agent run | `core/src/integrations/`                                                                     |        |
| A3  | Off-limits paths (mypal-specific extension)   | `core/RESUME_PROMPT.md`, `core/REVIEW_DECISIONS.md`, `docs/decisions/`, `docs/design/brand/` |        |

## F. Frontend adapters — pluggability

| #   | Question                                   | Default                                                                                                          | Answer |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------ |
| F1  | Which frontend adapters do you want at v0? | `discord` only at launch; `notion` and `cli` adapters drafted but built lazily as you (and your buddy) need them |        |

## G. Definition of "perfect" — needs your concrete take

| #   | Question                                                       | Default                                                                                                                                                                                | Answer |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G1  | Minimum bar for a harness-produced commit to land (code-class) | (a) lint clean, (b) tsc clean, (c) generator-drift clean, (d) reviewer-agent passes, (e) UAT 🟢, (f) zero new files added without explicit task plan, (g) attestation cross-check pass |        |
| G2  | What's an unrecoverable failure (aborts the run)               | tsc errors after 2 fix attempts; reviewer-agent flags `cross-tenant-leak`; structural-test failure; decision-assertion contradiction with no operator override                         |        |
| G3  | What metric do you watch weekly to grade the harness           | %commits landed without your edit + median run-time-to-commit + count of GC-surfaced drift cases auto-resolved + count of §V invariants accumulated                                    |        |

## D. Discord adapter specifics (only if you keep Discord at launch)

| #   | Question                                                                       | Default         | Answer |
| --- | ------------------------------------------------------------------------------ | --------------- | ------ |
| D1  | Guild (server) ID where the bot lives                                          | (provide ID)    |        |
| D2  | Owner Discord user-ID (allowlist; the only person whose commands are accepted) | (provide ID)    |        |
| D3  | Bot identity name                                                              | `mypal-harness` |        |
| D4  | DM commands enabled (admin commands only)                                      | yes             |        |

## N. Notion adapter specifics (only if you want the Notion frontend now)

If you skip these, harness omits the Notion adapter from v0; trivial to add later.

| #   | Question                                                                                | Default                                                                                                                | Answer |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| N1  | Notion tasks database — create a fresh one OR point at an existing?                     | create fresh during init (`harness init` walks you through Notion MCP to provision)                                    |        |
| N2  | Properties schema for the tasks DB                                                      | Title, Status (select), Trust Class (select), Pilot Module (text), Decision (select), Run-id (text), Cost USD (number) |        |
| N3  | Polling cadence for property changes                                                    | 5s (default; tune per-project)                                                                                         |        |
| N4  | Should the Notion adapter mirror Discord runs (read-only view) or be a primary frontend | adapter; configurable per run                                                                                          |        |

## S. Sensors — project-specific extension

| #   | Question                                                                                                             | Default                                                                      | Answer |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| S1  | Should the harness propose mypal-specific sensors automatically at init, or wait for explicit operator confirmation? | propose, await operator 🟢 per sensor                                        |        |
| S2  | Initial sensor disable list (sensors that have a known false-positive rate >50% on mypal today)                      | none — all sensors enabled at adoption; disable per-failure via `/oops` flow |        |

## T. Trust + budgets

| #   | Question                                                                                                    | Default                                                                                      | Answer |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| T1  | Hard daily $ budget on inference                                                                            | $50/day for first 4 weeks; revisit weekly                                                    |        |
| T2  | When the harness disables itself (3 consecutive sensor failures, budget exceeded, etc.), where does it page | Active frontend adapter — Discord DM if Discord registered, Notion page if Notion registered |        |

## M. Misc + portability

| #   | Question                                              | Default                                                                                                   | Answer |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Where does the harness pkg's source live              | inside this `Harness/` repo as a `harness/` workspace package; published to npm at `@isaac/harness` later |        |
| M2  | Should the init script auto-install Ollama if missing | yes — ask operator first via A/B/C dialog; option to skip                                                 |        |

---

## Quick-locks already baked in (no answer needed; listed for awareness)

- TypeScript stack
- pnpm monorepo
- Filesystem-only state (no DB)
- Direct commits to main; no branches; no PRs
- Mirror checkout at `~/.local/harness/repos/<project>/`
- Concurrency = 1
- Single Discord category structure (📋 backlog / 🟢 active / 📦 archive)
- Whisper.cpp via Homebrew, large-v3-turbo Q5
- Audio never written to disk
- Squares-into-square-holes UX
- Tier ladder with Ollama Tier 0
- Reviewer subagent same model as implementer
- Auto-merge: Option A (safe-class auto, code-class operator-confirmed, high-stakes E2E-gated)
- Backprop protocol (every fix → §V invariant)
- GC cadence (nightly)
- AGENTS.md = TOC, ~150 lines max
- All operator I/O multiple-choice-first
- Ollama for Tier 0 classification
- Two-zone canonical/historical separation (hook-enforced)
- Provenance frontmatter required on load-bearing markdown
- Stale doc → moved to `.archive/<date>/`
- MCP retrieval = structured graph traversal
- Append-only writes via MCP
- Evidence-file gate (SHA256-of-output)
- Custom linter remediation messages

If any of the above feels wrong on re-read, flag it as a free-form note and I'll regenerate the relevant doc.

---

## After you answer

1. The harness adopts these answers into `.harness/config/workflow.md` at init time.
2. Re-runnable: change a config value, daemon hot-reloads, takes effect on next dispatch.
3. No phase blocks on answering — operator can `/ship-anyway` defaults if you don't want to fill any of this in upfront.
