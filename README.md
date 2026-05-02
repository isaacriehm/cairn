# Harness

A portable, generic agent harness for solo developers. Discord-front-ended. Local-Whisper voice input. Filesystem-only state. Honest-agent invariants stack. Direct-commit workflow.

## Status

**Design phase.** No code yet. Documentation is the source of truth for the build.

## What this is

Operator console + orchestrator + grounding daemon for coding agents (Claude Code primary, Codex secondary). Symphony-shaped per OpenAI's open-source spec, but extended with Discord ingress, local Whisper transcription, anti-staleness invariants, and squares-into-square-holes UX (multiple-choice dialog over CLI flags).

## What it is NOT

- Not a multi-agent collaboration platform
- Not a hosted service
- Not a generic LLM framework
- Not opinionated about what your project does — only about how agents work on it

## Quick read order

1. [`docs/PRIMER.md`](docs/PRIMER.md) — concepts (read this first; ~600 lines)
2. [`docs/INTEGRATION_PLAN.md`](docs/INTEGRATION_PLAN.md) — phased build plan
3. [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md) — disk layout for any harness-adopted repo
4. [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) — agent tool surface
5. [`docs/UAT_PIPELINE.md`](docs/UAT_PIPELINE.md) — UAT-on-phone via Discord buttons
6. [`docs/WORKFLOW_GUIDE.md`](docs/WORKFLOW_GUIDE.md) — operator UX rules + tier ladder
7. [`docs/QUESTIONS.md`](docs/QUESTIONS.md) — residual open items

Research artifacts (mypal-derived; informed the design):

- [`docs/_research/STALENESS_INVENTORY.md`](docs/_research/STALENESS_INVENTORY.md)
- [`docs/_research/DISCORD_WHISPER_DESIGN.md`](docs/_research/DISCORD_WHISPER_DESIGN.md)

## License

TBD.
