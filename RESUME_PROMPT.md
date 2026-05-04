---
type: resume-prompt
status: package-split-handoff
audience: ai-only
generated: 2026-05-04
purpose: A fresh agent picking this up should NOT continue building runtime features. The mental model has been re-framed (Cairn = state + context layer; runtime + frontend are consumers). The packages skeleton is in place. Your job is to execute the file migration and verify, OR push back with a better plan if you spot a flaw.
---

# Resume Prompt — Cairn package split

You're picking up a project mid-refactor. Today's session diagnosed a per-Q dialog stall in the live Discord run, fixed it (commits below), and used the failure as the trigger for a bigger reframing: **Cairn is a state + context-loading layer for AI orchestration; the runtime + frontend adapters are consumers built on top, not part of its core**. The current `harness/` package conflates all three layers in a 2000-line orchestrator, which is what produced the brittle UX the operator's been hitting.

The conceptual split is locked: `docs/ARCHITECTURE.md` (new file). Four packages: `harness-core`, `harness-runtime`, `harness-frontend-discord`, `harness-frontend-stub`. Skeleton package.json + tsconfig + src/index.ts are all in place under `packages/`. They build clean. **What's left: move ~30 source files from `harness/src/` into the right package, rewrite imports, verify smokes still pass, and update the umbrella `harness/` to depend on the four sub-packages.**

Read this brief end-to-end. Then read `docs/ARCHITECTURE.md` and `docs/PRIMER.md`. Then either execute the migration per §3 below, or come back with a sharper plan if anything in this brief is wrong.

## 0. What's true at handoff

```
git log --oneline -8

746c54a fix: per-Q walk stall + UX cleanups (§3.4)         ← today
2515501 feat: steering primitives + run visibility (§3.2 + §3.3)  ← today
026f352 feat: init mapper (§3.1)                            ← today
9dd0557 docs: replace RESUME_PROMPT with rework brief      ← previous session
…
```

```
Working tree status:
  modified:  AGENTS.md, docs/PRIMER.md, pnpm-workspace.yaml, tsconfig.json
  new:       docs/ARCHITECTURE.md
  new:       packages/harness-core/{package.json, tsconfig.json, src/index.ts}
  new:       packages/harness-runtime/{package.json, tsconfig.json, src/index.ts}
  new:       packages/harness-frontend-discord/{package.json, tsconfig.json, src/index.ts}
  new:       packages/harness-frontend-stub/{package.json, tsconfig.json, src/index.ts}
```

The package skeletons build (`pnpm -r build` is green). They're empty stubs (`export const __SKELETON__ = "..."`). The umbrella `harness/` package still contains all the actual code and still builds + typechecks + passes its smokes.

sample-project test data has been wiped:
- `~/Documents/.../sample-project/.harness/` deleted (working tree clean)
- `~/.local/harness/repos/sample-project/` deleted (mirror gone)
- `~/.local/harness/state/sample-project/` deleted (state gone)
- `~/.local/harness/state/smoke_*` — smoke leftovers, still present (cleanup hygiene; not blocking)

## 1. The locked layered model

Read `docs/ARCHITECTURE.md`. The TL;DR:

- **harness-core** = state + context (ground writers, MCP, init mapper, GC, decision-capture, tightener, claude wrapper, tier0, stub-pattern catalog, decision-assertion evaluator, provenance).
- **harness-runtime** = orchestration consumer (orchestrator, FIFO, mirror, runner, sensors, reviewer, UAT, backprop, watchdog, slash handlers).
- **harness-frontend-discord** = Discord adapter (bot, voice, channels, slash, embed builder).
- **harness-frontend-stub** = test adapter for smokes.
- **harness** (umbrella) = CLI bin (`harness init/run/watch/task/install`), depends on all four. Smokes stay here for now.

The boundary is the `FrontendAdapter` interface (lives in harness-core). Runtime calls `adapter.requestDialog(spec)` — knows nothing about Discord vs CLI vs Notion.

## 2. Confirmed L01-L50 (still hold)

The architectural locks from prior sessions all hold. The split changes WHERE code lives, not WHAT it does. In particular:

- L02 — pnpm monorepo. The split makes this real, not aspirational.
- L08 — frontend adapter pluggability. Now actually plugged.
- L36 — generic harness pkg + per-project `.harness/config.yaml`. Becomes "harness-core is the generic pkg; per-project config is unchanged."
- L42 — Claude Code coding-plan quota is the budget metric. Cross-package, unchanged.
- L50 — project-agnostic harness pkg code. Now distributed across four packages, all still agnostic.

The L01-L50 list itself is in the prior RESUME_PROMPT (commit 9dd0557). Treat as binding.

## 3. The migration — file moves, in execution order

**Pre-flight:** all moves use `git mv` so blame is preserved. Don't `cp`+`rm` or rewrite history.

### 3.1 Move into `harness-core`

```
git mv harness/src/init                  packages/harness-core/src/init
git mv harness/src/mcp                   packages/harness-core/src/mcp
git mv harness/src/ground                packages/harness-core/src/ground
git mv harness/src/decision-capture      packages/harness-core/src/decision-capture
git mv harness/src/gc                    packages/harness-core/src/gc
git mv harness/src/claude                packages/harness-core/src/claude
git mv harness/src/tier0                 packages/harness-core/src/tier0
git mv harness/src/tightener             packages/harness-core/src/tightener
git mv harness/src/profiles              packages/harness-core/src/profiles
git mv harness/src/logger.ts             packages/harness-core/src/logger.ts
```

**Plus the FrontendAdapter contract types** — these are the seam between layers, they belong in core:

```
git mv harness/src/frontend/types.ts     packages/harness-core/src/frontend-types.ts
git mv harness/src/frontend/inbox.ts     packages/harness-core/src/inbox.ts
```

(`inbox.ts` is the inbox writer — used by both frontends and runtime; it's a state-layer concern.)

### 3.2 Move into `harness-runtime`

```
git mv harness/src/orchestrator          packages/harness-runtime/src/orchestrator
git mv harness/src/mirror                packages/harness-runtime/src/mirror
git mv harness/src/sensors               packages/harness-runtime/src/sensors
git mv harness/src/reviewer              packages/harness-runtime/src/reviewer
git mv harness/src/uat                   packages/harness-runtime/src/uat
git mv harness/src/backprop              packages/harness-runtime/src/backprop
git mv harness/src/watch                 packages/harness-runtime/src/watch
```

### 3.3 Move into `harness-frontend-discord`

```
git mv harness/src/frontend/discord      packages/harness-frontend-discord/src/discord
git mv harness/src/voice                 packages/harness-frontend-discord/src/voice
```

Voice lives here for now — only Discord uses it. Extract to its own package only when a second adapter wants it.

### 3.4 Move into `harness-frontend-stub`

```
git mv harness/src/frontend/stub         packages/harness-frontend-stub/src/stub
```

### 3.5 What stays in `harness/`

```
harness/src/cli/             — CLI bin (init/run/watch/task/install/daemon)
harness/src/index.ts          — re-exports (thin, becomes a re-export of the four packages)
harness/scripts/              — smokes (move per-package later; not phase 1)
harness/templates/            — `.harness/` skeleton for adopters
harness/package.json          — depends on the four sub-packages; bin entry stays
harness/tsconfig.json         — references the four sub-packages
```

After the moves, `harness/src/` only has `cli/` and `index.ts`.

## 4. Import rewrite plan

Every file's relative imports need rewriting.

### 4.1 Within a package — relative paths stay

Inside `packages/harness-core/src/init/init.ts`, `from "../logger.js"` still resolves correctly to `packages/harness-core/src/logger.js`. **No change for intra-package imports.**

### 4.2 Across packages — switch to package-name imports

| Old path (in harness/src) | New import (across packages) |
|----------------------------|------------------------------|
| `../init/index.js` | `@isaacriehm/harness-core` (re-exported) |
| `../mcp/server.js` | `@isaacriehm/harness-core/mcp` (sub-export) OR top-level re-export |
| `../mirror/index.js` | `@isaacriehm/harness-runtime` |
| `../frontend/types.js` | `@isaacriehm/harness-core` (FrontendAdapter contract) |
| `../frontend/discord/index.js` | `@isaacriehm/harness-frontend-discord` |
| `../frontend/stub/index.js` | `@isaacriehm/harness-frontend-stub` |
| `../orchestrator/index.js` | `@isaacriehm/harness-runtime` |
| `../tightener/index.js` | `@isaacriehm/harness-core` |
| `../tier0/index.js` | `@isaacriehm/harness-core` |
| `../sensors/index.js` | `@isaacriehm/harness-runtime` |
| `../reviewer/index.js` | `@isaacriehm/harness-runtime` |
| `../uat/index.js` | `@isaacriehm/harness-runtime` |
| `../backprop/index.js` | `@isaacriehm/harness-runtime` |
| `../decision-capture/index.js` | `@isaacriehm/harness-core` |
| `../claude/index.js` | `@isaacriehm/harness-core` |
| `../voice/index.js` | `@isaacriehm/harness-frontend-discord` (avoid this — runtime should not import voice) |
| `../logger.js` | `@isaacriehm/harness-core` |

### 4.3 Each package's `src/index.ts` becomes a re-export barrel

The current `packages/{X}/src/index.ts` has only `export const __SKELETON__`. Replace with re-exports from the moved subdirectories. Mirror the existing `harness/src/index.ts` structure.

### 4.4 The umbrella `harness/src/index.ts`

After the split, `harness/src/index.ts` becomes:

```ts
export * from "@isaacriehm/harness-core";
export * from "@isaacriehm/harness-runtime";
export * from "@isaacriehm/harness-frontend-discord";
export * from "@isaacriehm/harness-frontend-stub";
```

Backwards-compat for any adopter currently doing `import { runInit } from "@isaacriehm/harness"`.

### 4.5 Update `harness/package.json` deps

```json
"dependencies": {
  "@isaacriehm/harness-core": "workspace:*",
  "@isaacriehm/harness-runtime": "workspace:*",
  "@isaacriehm/harness-frontend-discord": "workspace:*",
  "@isaacriehm/harness-frontend-stub": "workspace:*",
  // … keep CLI-specific deps (inquirer for install command, etc.)
}
```

Drop deps that are now sub-package concerns (chokidar, discord.js, smart-whisper, simple-git, fastify, ws, zod, yaml — they live where they're used now).

### 4.6 Update `harness/tsconfig.json`

Add `"references"` to the four sub-packages.

## 5. Likely gotchas

1. **Circular imports.** `harness-core/types.ts` defines `FrontendAdapter` which references types like `DialogSpec`. If a frontend implementation tries to import a type-only thing from another frontend, that's circular. **Fix:** the FrontendAdapter contract is type-only; types live in `harness-core` and frontends `import type { FrontendAdapter, DialogSpec, … }`.
2. **`runImplementer` (`harness/src/orchestrator/runner.ts`) shells out to claude.** It's runtime's responsibility, not core's. But core also has `claude/runner.ts` for one-shot calls (tightener, mapper). **Keep both.** Two different consumers; both need the subprocess wrapper. Either: keep two copies, OR factor a `claude-spawn.ts` helper into harness-core that both wrappers use.
3. **The CLI calls into all four packages.** `harness/src/cli/init.ts` already imports from `init/`, `secrets/`, `mirror/`, `discord adapter`. Post-split the CLI's imports are all `@isaacriehm/harness-...`. Adapters that need wiring at start-up time (Discord token, ownerIds env) are passed in by the CLI.
4. **Smokes break first.** Every smoke imports from `../src/...`. The smokes live in `harness/scripts/`, so post-move imports become `@isaacriehm/harness-...` because the source moved. **Update each smoke's imports.** ~25 smokes. Cheap.
5. **Templates.** `harness/templates/` stays where it is. The init package's `seed.ts` references `templatesRoot()` which derives from `import.meta.url`; after moving init.ts to harness-core, `templatesRoot()` resolves relative to harness-core/dist/init/seed.js. **Either:** copy templates/ into harness-core, OR update `templatesRoot()` to walk back up to find the umbrella's templates/. **Recommend:** copy templates into `packages/harness-core/templates/` since the templates are an init-time concern.
6. **`@inquirer/prompts` is in harness/package.json but used by both init (core) and the CLI install command.** Move to harness-core's deps; CLI's install command can import via the umbrella re-export.
7. **`zod` dep.** Currently in harness; moves to harness-core (used for MCP schemas + mapper output validation? — verify; keep where used).

## 6. Verification — what passes after the migration

After moves + import rewrites:

```
pnpm install                      # workspace links resolve
pnpm -r build                     # all five packages compile
pnpm -F @isaacriehm/harness check:layout  # path allowlist still right
pnpm -F @isaacriehm/harness smoke:mirror smoke:watch smoke:mcp \
                              smoke:tier0 smoke:tightener smoke:sensors \
                              smoke:reviewer smoke:uat smoke:gc smoke:backprop \
                              smoke:decision-capture smoke:decision-refinement \
                              smoke:init smoke:init-mapper smoke:steering \
                              smoke:visibility smoke:ux-cleanups \
                              smoke:quota-archive smoke:cli-extras
```

Smoke:uat step 14 hangs on real chromium launch (environmental, predates this work) — skip in verification.

## 7. Doc updates that ride along

After the migration:

- **`AGENTS.md`** — already updated; no further changes.
- **`docs/PRIMER.md`** — already has the §0 disclaimer; rewrite §3 to drop the "Symphony-shaped harness" framing.
- **`docs/INTEGRATION_PLAN.md`** — currently frames everything as one package. Add §0.5 noting the split, OR move the file to `docs/_history/` and create a fresh `INTEGRATION_PLAN.md` aligned with the new layout. **Recommend:** add a top-level "superseded by ARCHITECTURE.md" banner; don't rewrite (the old phase plan is historical).
- **`docs/MCP_SURFACE.md`** — note that the MCP server lives in `harness-core`. No content change.
- **`docs/FILESYSTEM_LAYOUT.md`** — no change (talks about adopted-project layout, not Cairn's own layout).
- **`docs/WORKFLOW_GUIDE.md`** — no change.

## 8. After the migration — what's possible

Adopters can:

- `npx -y @isaacriehm/harness-core init` — bootstrap `.harness/ground/` + run init mapper, skip the orchestrator and run `claude code` manually with the MCP server registered. This is the "I just want curated state" mode.
- `npx -y @isaacriehm/harness-core@latest @isaacriehm/harness-runtime@latest run --frontend stub` — orchestrator-driven dispatch without Discord. Useful for CI.
- `npx -y @isaacriehm/harness@latest run --project sample-project --frontend discord` — full stack. Today's behavior.

Each layer is documented + smoke-covered + independently versionable.

## 9. Operator profile (binding — applies to your replies + commits)

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. Lead with answer/action. Caveman ultra mode active for chat replies; commits + PRs + docs are full English. |
| Decisions | Fast-intuitive. Don't present options unless explicitly asked. When operator states a decision, treat it as final. |
| Explanations | Concise. Root cause in 1-2 sentences then fix. |
| UX Philosophy | Design-conscious. UX = functional correctness. |
| Vendor Choices | Opinionated. Don't suggest alternatives unless they avoid real risk. |
| Env vars | Hates env vars. Hardcoded model IDs in code = correct. |
| Tests | "Tests are shitware. Only E2E with real DB matters." Drop the test framing entirely. Sensors and E2E only. |
| Backward compat | Hates backward compat. No transition shims. Hard cutovers. |
| Inquirer | Use `@inquirer/prompts` for all CLI dialogs. Never hand-roll readline. |
| Mobile mode | When operator is on mobile, AskUserQuestion options get truncated. Switch to chat-mode K/R/U/M with concise option labels. |

## 10. What NOT to do

- Do not run the migration as `cp`+`rm`. Use `git mv` so blame survives.
- Do not rewrite the orchestrator while moving it. Keep behavior identical; the split is structural only.
- Do not delete the umbrella `harness/` package. It's the entry point for adopters who want everything.
- Do not break the existing smokes. After the import rewrite, every smoke should still pass (modulo smoke:uat step 14 chromium hang which is environmental).
- Do not promote any adapter (Discord, voice, etc.) into harness-core. The whole point of the split is that core doesn't know what adapter is running.
- Do not start phase 17 (trial pilot) or phase 18 (anything new) until the migration lands and smokes are green. The "we shipped lots of features but the integrated experience is broken" pattern from the prior session must not repeat.

## 11. References

- `docs/ARCHITECTURE.md` — locked layered model, package contents, FrontendAdapter contract, MCP surface, migration path
- `docs/PRIMER.md` — concepts, anti-patterns (§11), glossary
- `docs/INTEGRATION_PLAN.md` — historical phase plan (will be retitled superseded after migration)
- `docs/MCP_SURFACE.md` — 18 MCP tools (lives in harness-core)
- `docs/UAT_PIPELINE.md` — Layer U pipeline (lives in harness-runtime)
- `docs/WORKFLOW_GUIDE.md` — operator UX rules + tier ladder + slash surface
- `docs/QUESTIONS.md` — residual open items
- `docs/CODEX_REVIEW_BRIEF_REVIEW.md` — Codex's audit findings (3 must-fix landed via L41/L43–L48)

## 12. Fast-start checklist

```
□ Read this file.
□ Read docs/ARCHITECTURE.md.
□ Read docs/PRIMER.md (skim for §11 anti-patterns).
□ git log --oneline -8  → confirm three commits from 2026-05-04 landed.
□ pnpm -r build  → confirm packages skeleton builds.
□ Confirm to operator in 3-4 lines:
  "Loaded handoff. Skeleton builds. Ready to execute §3 migration. Start now?"
□ Wait for explicit approval.
□ Execute §3 git mv chain. After each subdir, fix imports + verify pnpm -r build.
□ Update harness/src/index.ts as the re-export barrel.
□ Update each smoke's imports.
□ Run smoke battery (skip smoke:uat which hangs on chromium).
□ Commit:
    refactor: package split per docs/ARCHITECTURE.md (state + context layered model)
□ Hand back to operator with: "split landed; smokes green; ready for next."
```

End of brief.
