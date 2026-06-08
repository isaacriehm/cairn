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

| What                                                                 | Where                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| Quick start + concepts                                               | [`README.md`](README.md)                                     |
| Layered architecture (locked)                                        | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)               |
| Plugin spec — adoption phases, hooks, multi-dev enforcement (locked) | [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) |
| MCP tool surface — tool-by-tool reference                            | [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md)                 |
| `.cairn/` directory contract                                         | [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md)     |
| License                                                              | [`LICENSE`](LICENSE)                                         |

## Operator profile (apply when communicating with the operator)

| Trait              | Behavior                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Communication      | Terse-direct. Lead with answer or action. No filler.                                                                           |
| Decisions          | Fast-intuitive. Don't present options unless explicitly asked. When the operator states a decision, treat it as final.         |
| Explanations       | Concise. Root cause in 1-2 sentences then the fix.                                                                             |
| UX philosophy      | Design-conscious. UX is equal in importance to functional correctness.                                                         |
| Vendor choices     | Opinionated. Do not suggest alternative libraries / frameworks unless they avoid a real risk.                                  |
| Env vars           | The operator hates env vars. Hardcode model IDs and paths in code.                                                             |
| Tests              | "Tests are shitware. Only E2E with real DB matters." Sensors + E2E smokes only — no unit-test framing.                         |
| Backward compat    | The operator hates backward-compat shims. Hard cutovers only.                                                                  |
| Mobile mode        | When the operator is on mobile, `AskUserQuestion` options get truncated; switch to chat-mode A/B/C with concise option labels. |
| Caveman ultra mode | Active for chat replies. Documents stay in full English.                                                                       |

## Hard rules

- All design decisions live in `docs/`. Drift between conversation and `docs/` is a bug.
- Locked architectural decisions in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (§1 layered model, §3 package contents) and [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) (§3 package layout, §17 multi-dev) are not reopened without explicit operator instruction.
- Never use Claude Code `PreToolUse` hooks — they can brick the session. SessionStart instructions + MCP tools only.
- Hardcode model IDs in code (no env vars). Hard cutovers only (no transition shims).

### Operator-private strings: never write to a committed artifact

This is a public open-source repository. Any string visible from the
runtime context that identifies the operator personally — the absolute
working-directory path, parent folders above the repo root, the
operator's umbrella organization name (visible in the cwd path
segments), the operator's email address, any private project
codenames — must NEVER appear in:

- Committed source code (including comments)
- Documentation (`README.md`, `CHANGELOG.md`, `docs/**`)
- Git commit messages or tag annotations
- Subagent prompts that produce committed output
- The `.claude-plugin/` manifest or any other shipped artifact

The public maintainer name attached to the repo's package metadata
and LICENSE is the only personally-identifying string allowed; it is
the deliberate public attribution. Everything else from the operator's
local environment is private, do not mention even redacted references.

When describing a class of bug that involves one of these strings
(e.g. "paths with spaces"), use a generic placeholder such as
`/path/with spaces/...`, `<operator-home>`, or `<personal-email>`.
Do NOT quote the operator's actual path even inside an error string,
even inside a fenced code-block, even inside a commit-message body.

Enforcement is by attention, not tooling. Violations have shipped
publicly more than once. If unsure whether a string qualifies as
operator-private, OMIT IT — there is no "borderline" category.

## Workspace layout

```
cairn/
└── packages/
    ├── cairn/                       — umbrella + CLI bin (`cairn init/join/hook/...`)
    ├── cairn-core/                  — MCP server + sensors + hook runners + init pipeline
    ├── cairn-state/                 — ground-state schemas + low-level I/O
    ├── cairn-frontend-claudecode/   — Claude Code plugin (manifest + hooks + skills + agents + commands)
    └── cairn-lens/                  — VS Code / Cursor extension (.vsix)
```

`.cairn/` is kept as the on-disk state directory name — it's the
technical surface ("the cairn wraps the agent"); Cairn is the project
brand. Same with the `cairn_*` MCP tool prefix.

## Common commands

Root-level pnpm scripts. No filter args, no package navigation, no bash loops.

| Command                            | What                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `pnpm install`                     | Install workspace deps.                                       |
| `pnpm build`                       | Build all packages.                                           |
| `pnpm typecheck`                   | Typecheck all packages.                                       |
| `pnpm clean`                       | Wipe `dist/` + `*.tsbuildinfo` across packages.               |
| `pnpm smokes`                      | Run the 38-smoke gate. All must pass on a clean tree.         |
| `pnpm smokes:all`                  | Run every declared smoke (~46). Slower; pre-release sweep.    |
| `pnpm smoke:llm-prompt-eval`       | Opt-in real-Haiku regression smoke (burns quota — see below). |
| `pnpm version:check`               | Verify package versions in sync.                              |
| `pnpm release:patch\|minor\|major` | Bump versions across the workspace.                           |

Bootstrap once:

```bash
pnpm install
pnpm build
pnpm smokes
```

### Opt-in: real-LLM regression smoke

`pnpm smoke:llm-prompt-eval` runs the Phase 8 Stage-1 file-purpose
filter prompt against three inline fixtures (ADR, UAT log, research
scratchpad) using **real Haiku** — it burns operator quota and is
**not** part of `pnpm smokes`. Run only when:

- touching the Stage-1 system prompt
  (`packages/cairn-core/src/init/ingest-docs.ts` → `FILE_FILTER_SYSTEM`), or
- upgrading the Haiku model alias used by `runClaude`.

If a fixture flips, surface the failure — do not silently weaken the
assertions.

## Starting fresh

1. Read [`README.md`](README.md) end-to-end.
2. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — locked layered model.
3. Read [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) — plugin spec.
4. Skim [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) and [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md).
5. Confirm to the operator in 2-3 lines what you've loaded.
6. Match the operator's terse-direct style.
