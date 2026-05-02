# Harness — Project Orientation (TOC pattern)

This is the table of contents for agents working in this repo. Per OpenAI's harness lesson — *"treat AGENTS.md as the table of contents"* — keep this file under ~150 lines. All real content lives in `docs/`.

## What this project is

A portable agent harness. Generic Discord-front-ended orchestrator with local Whisper voice input, filesystem-only state, honest-agent invariants, and direct-commit workflow. Designed for solo developers using Claude Code (primary) and Codex (secondary).

**Currently:** design phase. No code. Documentation is the source of truth.

## Project state

| Item | Location |
|------|----------|
| The current handoff | [`RESUME_PROMPT.md`](RESUME_PROMPT.md) — read this first if you are a freshly-spawned agent |
| Concept primer | [`docs/PRIMER.md`](docs/PRIMER.md) |
| Phased build plan | [`docs/INTEGRATION_PLAN.md`](docs/INTEGRATION_PLAN.md) |
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

- This project ships nothing yet. Do not write code in this repo unless explicitly asked.
- All design decisions are recorded in `docs/`. Drift between conversation and `docs/` is a bug.
- Anti-patterns are named and rejected in `docs/PRIMER.md` §11. Do not propose anything on that list.
- Locked architectural decisions in `docs/PRIMER.md` and `docs/INTEGRATION_PLAN.md` are not reopened without explicit operator instruction.

## When you (an agent) are starting fresh

1. Read [`RESUME_PROMPT.md`](RESUME_PROMPT.md) end-to-end.
2. Read [`docs/PRIMER.md`](docs/PRIMER.md).
3. Skim the other `docs/*.md` files.
4. Confirm to the operator in 2-3 lines what you've loaded and ask what to work on next.
5. Match the operator's terse-direct style.

## When implementation begins (future)

This file gets backed by additional rules under `.claude/rules/*` (path-scoped). A `harness/` workspace package will be the runtime. See `docs/INTEGRATION_PLAN.md` Phase 0.
