# Cairn — Project Orientation

This is the file Claude Code reads on every session. It's the table of
contents for agents working on this repo — kept under ~150 lines so it
fits in the SessionStart context budget. Real content lives in `docs/`.

## What this project is

**Cairn = state + context-loading layer for AI coding agents.** It curates
`.cairn/ground/` (decisions, §V invariants, canonical-map, brand,
quality-grades), exposes that state via an MCP server, and ships a Claude
Code plugin that wires adoption + the daily flow inline.

The Claude Code plugin is the primary surface; the CLI (`cairn ...`) is the
bootstrap and debug entrypoint. There is no separate orchestration runtime
— the plugin uses Claude Code's built-in subagent dispatch.

## Document index

| What | Where |
|------|-------|
| Quick start + concepts | [`README.md`](README.md) |
| Layered architecture (locked) | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Plugin spec — adoption phases, hooks, multi-dev enforcement (locked) | [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) |
| MCP tool surface — tool-by-tool reference | [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) |
| `.cairn/` directory contract | [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md) |
| License | [`LICENSE`](LICENSE) |

## Operator profile (apply when communicating with the operator)

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. Lead with answer or action. No filler. |
| Decisions | Fast-intuitive. Don't present options unless explicitly asked. When the operator states a decision, treat it as final. |
| Explanations | Concise. Root cause in 1-2 sentences then the fix. |
| UX philosophy | Design-conscious. UX is equal in importance to functional correctness. |
| Vendor choices | Opinionated. Do not suggest alternative libraries / frameworks unless they avoid a real risk. |
| Env vars | The operator hates env vars. Hardcode model IDs and paths in code. |
| Tests | "Tests are shitware. Only E2E with real DB matters." Sensors + E2E smokes only — no unit-test framing. |
| Backward compat | The operator hates backward-compat shims. Hard cutovers only. |
| Mobile mode | When the operator is on mobile, `AskUserQuestion` options get truncated; switch to chat-mode A/B/C with concise option labels. |
| Caveman ultra mode | Active for chat replies. Documents stay in full English. |

## Hard rules

- All design decisions live in `docs/`. Drift between conversation and `docs/` is a bug.
- Locked architectural decisions in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (§1 layered model, §3 package contents) and [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) (§3 package layout, §17 multi-dev) are not reopened without explicit operator instruction.
- Never use Claude Code `PreToolUse` hooks — they can brick the session. SessionStart instructions + MCP tools only.
- Hardcode model IDs in code (no env vars). Hard cutovers only (no transition shims).

## Workspace layout

```
cairn/
└── packages/
    ├── cairn/                       — umbrella + CLI bin (`cairn init/join/hook/...`)
    ├── cairn-core/                  — state + context + MCP server + sensors + hook runners
    ├── cairn-frontend-claudecode/   — Claude Code plugin (manifest + hooks + skills + agents + commands)
    ├── cairn-frontend-stub/         — in-memory test adapter (internal)
    └── cairn-lens/                  — VS Code / Cursor extension (.vsix)
```

`.cairn/` is kept as the on-disk state directory name — it's the
technical surface ("the cairn wraps the agent"); Cairn is the project
brand. Same with the `cairn_*` MCP tool prefix.

## Smoke gate

```bash
pnpm install
pnpm -r build
for s in plugin-layout resolve-attention stop-hook events session-state \
         status-line session-start handoff scope-index read-enrich init \
         ingestion-baseline tier0 gc lock source-comments rules-merge join \
         bypass-detection bootstrap-guard e2e-adoption e2e-daily-flow; do
  pnpm --filter @isaacriehm/cairn "smoke:$s"
done
```

22 smokes; all should pass on a clean tree.

## Starting fresh

1. Read [`README.md`](README.md) end-to-end.
2. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — locked layered model.
3. Read [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) — plugin spec.
4. Skim [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) and [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md).
5. Confirm to the operator in 2-3 lines what you've loaded.
6. Match the operator's terse-direct style.
