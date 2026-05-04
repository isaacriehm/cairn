---
type: meta
status: dormant
generated: 2026-05-04
purpose: Code preserved for future implementation but not part of the active build
---

# `_dormant/` — preserved code, not in the build

This directory holds packages and files that were architecturally decided to **not** ship in the current `harness-frontend-claudecode` plugin pivot, but whose code is worth preserving for future revival.

The `_dormant/` tree is **outside** the pnpm workspace (`packages: ["packages/*"]`). It is not built, not type-checked, not linked. Browsable but inert.

## What's here

| Item | Original location | Reason dormant |
|------|-------------------|----------------|
| `harness-runtime/` | `packages/harness-runtime/` | Orchestration runtime (FIFO queue, mirror checkout, claude subprocess dispatch, reviewer, UAT pipeline). The plugin pivot leverages Claude Code's existing subagent capability instead, so the runtime layer is paused. |
| `harness-frontend-discord/` | `packages/harness-frontend-discord/` | Discord adapter (bot, voice, channels, slash commands). Operator works in Claude Code directly under the new model. |
| `harness-cli/run.ts` | `packages/harness/src/cli/run.ts` | `harness run` CLI — orchestrator + frontend adapters runner. Tied to the dormant runtime. |
| `harness-cli/watch.ts` | `packages/harness/src/cli/watch.ts` | `harness watch` CLI — long-lived grounding daemon. Daemon killed; tied to dormant runtime. |
| `harness-scripts/smoke-*.ts` | `packages/harness/scripts/smoke-*.ts` | Smokes that exercise dormant code (orchestrator, discord, reviewer, UAT, watch, backprop, mirror). |

See `docs/PLUGIN_ARCHITECTURE.md` §16 (Migration) for the architectural rationale.

## How to revive

To bring an item back into the active build:

1. `git mv _dormant/<item>` → `packages/<item>` (or `packages/harness/src/cli/` etc.)
2. Add to `pnpm-workspace.yaml` if it's a workspace package (already covered by `packages/*` glob — just place under that tree)
3. Add tsconfig project reference at the root `tsconfig.json` AND in any package that depends on it
4. Add as a workspace dep in consuming packages' `package.json`
5. Restore re-exports if applicable
6. `pnpm install && pnpm -r build` to verify

Each item's package boundaries were preserved on the move, so revival is a mostly mechanical inverse of the migration.

## Do not modify

Files in `_dormant/` are a frozen snapshot. Don't fix bugs, refactor, or update them in place — when a dormant item is revived, treat the revival commit as the place to bring it up to date.
