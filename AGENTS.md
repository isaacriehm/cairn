# Harness — Project Orientation (TOC pattern)

This is the table of contents for agents working in this repo. Per OpenAI's harness lesson — *"treat AGENTS.md as the table of contents"* — keep this file under ~150 lines. All real content lives in `docs/`.

## What this project is

**Harness = state + context-loading layer for AI orchestration.** It curates `.harness/ground/` (decisions, §V invariants, canonical-map, quality-grades), exposes that state via an MCP server, and provides bootstrapping (init mapper) + maintenance (GC drift sweep + backprop) for it.

Orchestration runtime (FIFO queue, mirror checkout, claude subprocess dispatch, sensor sweep, reviewer, UAT pipeline) is a **consumer** built on top. Discord / voice / channel-per-task is a **frontend adapter** consuming the runtime. Each layer is its own pnpm workspace package.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the layered model and the four-package boundary. The earlier "agent orchestrator with Discord UX bolted on" framing in PRIMER §3 + INTEGRATION_PLAN §1 is superseded.

## Project state

| Item | Location |
|------|----------|
| The current handoff | [`harness-build/RESUME.md`](harness-build/RESUME.md) — read this first if you are a freshly-spawned agent |
| **Locked architecture (layered model)** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Concept primer | [`docs/PRIMER.md`](docs/PRIMER.md) |
| Phased build plan (historical — see ARCHITECTURE for current model) | [`docs/INTEGRATION_PLAN.md`](docs/INTEGRATION_PLAN.md) |
| Filesystem layout for adopted projects | [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md) |
| MCP server tool surface | [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) |
| UAT-on-phone pipeline | [`docs/UAT_PIPELINE.md`](docs/UAT_PIPELINE.md) |
| Operator UX + tier ladder | [`docs/WORKFLOW_GUIDE.md`](docs/WORKFLOW_GUIDE.md) |
| Open questions for the operator | [`docs/QUESTIONS.md`](docs/QUESTIONS.md) |
| Research artifacts (mypal-derived) | [`docs/_research/`](docs/_research/) |

## Operator profile (apply when communicating with the user)

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. Lead with answer/action. No filler. |
| Decisions | Fast-intuitive. Don't present options unless explicitly asked. When user states a decision, treat it as final. |
| Explanations | Concise. Root cause in 1-2 sentences then fix. |
| UX Philosophy | Design-conscious. UX equal in importance to functional correctness. |
| Vendor Choices | Opinionated. **Do not suggest alternative libraries/frameworks unless they avoid real risk.** |
| Env vars | **Hates env vars.** Only secrets/brand/domain go in env. Hardcoded model IDs in code = correct. |
| Tests | "Tests are shitware. Only E2E with real DB matters." Drop the test framing entirely. Sensors and E2E only. |
| Backward compat | **Hates backward compat.** No transition shims. Hard cutovers. |
| Mobile mode | When operator is on mobile, AskUserQuestion options get truncated. Switch to chat-mode K/R/U/M with concise option labels. |
| Caveman ultra mode | Active for chat replies. Documents in full English. |

## Hard rules

- All design decisions are recorded in `docs/`. Drift between conversation and `docs/` is a bug.
- Anti-patterns are named and rejected in `docs/PRIMER.md` §11. Do not propose anything on that list.
- Locked architectural decisions in `docs/ARCHITECTURE.md` (§1 layered model, §3 package contents) are not reopened without explicit operator instruction.

## Workspace layout (post-split)

```
Harness/                         — repo root (this file lives here)
└── packages/
    ├── harness/                  — umbrella + CLI bin (`harness init/run/…`)
    ├── harness-core/             — state + context + MCP. The Harness.
    ├── harness-runtime/          — orchestration consumer (FIFO, mirror,
    │                               sensors, reviewer, UAT, dispatch)
    ├── harness-frontend-discord/ — Discord adapter (bot, voice, channels)
    ├── harness-frontend-stub/    — in-memory test adapter
    └── harness-lens/             — VS Code / Cursor extension (.vsix)
```

## When you (an agent) are starting fresh

1. Read [`harness-build/RESUME.md`](harness-build/RESUME.md) end-to-end.
2. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — locked layered model.
3. Read [`docs/PRIMER.md`](docs/PRIMER.md) for concepts + anti-patterns.
4. Skim the other `docs/*.md` files.
5. Confirm to the operator in 2-3 lines what you've loaded and ask what to work on next.
6. Match the operator's terse-direct style.
