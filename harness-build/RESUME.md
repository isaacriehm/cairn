---
type: handoff
generated: 2026-05-04
purpose: Resume prompt for a fresh Claude Code session continuing the plugin-pivot build
supersedes: harness-build/HANDOFF_PLUGIN_PIVOT.md
---

# Resume — plugin pivot build

You are a fresh Claude Code session continuing the harness plugin pivot. Read this top-to-bottom, then ask the operator which build-sequence step to execute next.

## TL;DR

The plugin architecture is fully specced and locked at `docs/PLUGIN_ARCHITECTURE.md`. Steps 1-3a of the build sequence are done. Steps 3b-10 remain. Operator wants execution to be autonomous within each step — surface only genuinely load-bearing forks, not every minor fork.

## Load-bearing reads (in order)

1. **`docs/PLUGIN_ARCHITECTURE.md`** — the canonical spec. 600 lines, 19 sections. Everything below is cross-references into it.
2. **`AGENTS.md`** — table-of-contents for the project + operator profile.
3. **`harness-build/BUILD_LOG.md`** — append your work here on completion.
4. **Memory:** `~/.claude/projects/-Users-user-Documents-DevPlus-LLC-06---Projects-Harness/memory/MEMORY.md`. Especially:
   - `feedback_harness_invisible_infra.md` — UX is invisible; only inline A/B/C
   - `feedback_decide_dont_overprompt.md` — make calls on inferable forks; surface only ≤2-3 truly load-bearing ones
   - `feedback_pretooluse_hooks.md` — never use PreToolUse (bricks session)

## Operator profile (do not violate)

| Trait | Behavior |
|-------|----------|
| Communication | Terse-direct. Lead with answer/action. No filler. No pleasantries. |
| Caveman ultra mode | Active for chat replies. Documents in full English. Code/commits/PRs normal. |
| Decisions | Fast-intuitive. Don't surface options unless you genuinely cannot infer. When operator states a decision, treat as final. |
| Env vars | **Hates env vars.** Hardcoded model IDs / paths in code = correct. |
| Tests | "Tests are shitware. Only E2E with real DB matters." Smokes only — no unit-test framing. |
| Backward compat | **Hates backward compat.** No transition shims. Hard cutovers. |
| Mobile mode | When operator is on mobile, AskUserQuestion options get truncated. Switch to chat-mode A/B/C with concise option labels. |

## What's done (9 commits this session)

```
2d99689  feat(lock): per-write flock for global state writes
e3366eb  feat(tier0): replace Ollama with Claude binary (Haiku)
1b6fee1  chore(_dormant): mirror, voice, daemon-autostart off the build path
... (step 1b)
1b6fee1  chore(_dormant): move runtime + discord adapters off the build path
... (step 1a)
7c5f16c  docs: plugin architecture spec
8456765  chore(docs): archive pre-pivot specs, build artifacts, research
5c65e15  chore(repo): unify packages, drop tracked tarballs, tidy gitignore
fcf4a87  chore: deep review pass + plugin-pivot handoff
```

(See `git log --oneline -12` for the full picture.)

### Concretely

- **Repo unified** — all six packages live under `packages/*`. `pnpm-workspace.yaml` simplified. Five `.tgz` build artifacts untracked, `*.tgz` gitignored.
- **Plugin spec written** — `docs/PLUGIN_ARCHITECTURE.md` is the authoritative source for everything. Cross-reference it; never reinvent.
- **Dormant tree established** — `_dormant/` (root, outside workspace) holds:
  - `harness-runtime/` — orchestration runtime (FIFO + mirror + claude subprocess + UAT)
  - `harness-frontend-discord/` — discord adapter
  - `harness-cli/{run,watch,mirror,task,daemon,install}.ts` — CLI subcommands tied to dormant code
  - `harness-core-{mirror,voice,init,tier0}/` — submodules pulled out of `harness-core`
  - `harness-scripts/smoke-{orchestrator,discord,reviewer,uat*,watch,backprop,mirror}.ts` — smokes for dormant code
  - `README.md` documents revival path
- **Path utility extracted** — `packages/harness-core/src/paths/` holds `normalizeProjectName`, `projectStatePath`, `harnessHome`, `stateRoot`, `modelsRoot`. The rest of `mirror/` is dormant.
- **Daemon killed** — `daemon-autostart.ts` dormant, `tryStartDaemon` removed from `runFix`, daemon-related rows stripped from completion summary, `harness daemon/install/uninstall/run/watch/mirror/task` CLI subcommands gone.
- **Ollama killed** — `tier0/classify.ts` calls `runClaude` with Haiku tier + JSON-schema. Source field is `"claude" | "fallback"`. Init drops Ollama probe + brew install + `OLLAMA_HOST`. `discord_token`/`discord_guild` env probes also dropped.
- **Lock module live** — `harness-core/src/lock.ts` exports `withWriteLock` + `acquireOperationLock` + `OperationLockHeldError`. Threaded through `harness_record_decision`, `harness_archive`, `harness_drop_task`. New `smoke-lock` verifies serialization + held-lock-throws.

## Active workspace

```
packages/
  harness/                         — umbrella + CLI bin (`harness init` + debug-only subcommands)
  harness-core/                    — state + MCP + tier0 + tightener + sensors + GC
  harness-frontend-stub/           — test adapter
  harness-lens/                    — VS Code/Cursor IDE extension
```

`harness-frontend-claudecode/` not yet scaffolded — that's step 4.

## Build sequence remaining

Per `docs/PLUGIN_ARCHITECTURE.md` §19. Each step is its own commit + BUILD_LOG entry + compile gate.

| Step | Title | Notes |
|------|-------|-------|
| 3b | Per-session state partition | `.harness/sessions/<session-id>/` directory; status.json reader + writer per-session-aware; SessionEnd cleanup; stale-session GC at SessionStart. Update `status-line/writer.ts` (currently writes `~/.local/harness/state/<slug>/status.json` — should move into per-session under repo). |
| 3c | Invalidation events + watcher | Writer in `harness-core/src/events.ts` writes `.harness/events/<ts>-<event>.json` on global-state changes. Plugin Stop hook polls events dir (chokidar file watcher armed at SessionStart, debounced). 7-day retention. |
| 4 | Scaffold `packages/harness-frontend-claudecode/` | `.claude-plugin/plugin.json` manifest, `.mcp.json`, `hooks/hooks.json`, empty `skills/`, `agents/`, `commands/` dirs. Verify `pnpm install` + `pnpm -r build` clean with the new package. |
| 5 | Implement skills | `skills/harness-adopt/SKILL.md`, `skills/harness-direction/SKILL.md`, `skills/harness-attention/SKILL.md`. Each is markdown + frontmatter `description` for auto-invocation. Plus `commands/harness-init.md` and `commands/harness-direction.md` slash commands. |
| 6 | Reviewer subagent | `agents/reviewer.md` — markdown brief + role spec. Stop hook scans `.harness/tasks/active/<id>/` for missing `attestation.yaml` and spawns reviewer. |
| 7 | Heavy adoption pipeline | Extend init Phase 6 — Phase 7b (full-repo source-comment ingestion: deterministic detect heuristic, Haiku batch-classify 20 blocks/call), Phase 7c (existing rules merge with `<!-- harness:keep-start -->` markers), Phase 10 (deterministic strip + replace, uncommitted-changes pre-check + stash/skip/overwrite, originals to `.harness/backups/source/<rel>.original`, per-module batch consent + per-file escalation). |
| 8 | Multi-dev enforcement | Versioned git hooks at `.harness/git-hooks/`, `core.hooksPath` config, `.attested-commits` marker file (paired post-commit hook), `.github/workflows/harness-check.yml` CI gate, `.harness/JOIN.md` for new contributors, `harness join` CLI bootstrap, `package.json` `prepare` script for Node projects. |
| 9 | End-to-end smoke | Install plugin into a fresh test project (mypalcrm or a clean fixture), run full adoption, verify daily flow with a small task. |
| 10 | Pre-publish prep | gitleaks scan; content audit (mypal references in BUILD_LOG, archives); operator decides on history wipe; fresh public repo with current clean working tree as initial commit. |

## How to start

1. Read this file end-to-end.
2. Read `docs/PLUGIN_ARCHITECTURE.md` end-to-end.
3. Verify the build is clean:
   ```bash
   pnpm install
   pnpm -r build
   pnpm --filter @devplusllc/harness check:layout
   ```
4. Confirm to the operator in 2-3 lines what you've loaded. Ask which build-sequence step to execute next (default suggestion: step 3b — per-session state partition).
5. Match the operator's terse-direct caveman-ultra style for chat replies. Documents stay full English.

## Hard rules

- **Do not invent decisions.** All architecture is in `docs/PLUGIN_ARCHITECTURE.md`. If something seems missing, re-read first; if genuinely undefined, surface as a single load-bearing question to the operator.
- **Do not over-prompt.** Memory file `feedback_decide_dont_overprompt.md` documents the operator's pushback on this. Cap surfaced questions to ≤2-3 per round, all genuinely load-bearing.
- **Do not revive dormant code.** `_dormant/` exists for a reason — its revival is a future operator decision, not something to undo as a side-effect of build work.
- **Do not write env vars.** Operator hates them. Hardcode model IDs in code, paths in code.
- **Do not add backward-compat shims.** Hard cutovers only. If a refactor breaks something, fix the consumer, don't leave a transitional layer.
- **Do not commit without an explicit `pnpm -r build` pass.** Compile gate is non-negotiable.
- **Do not merge unrelated work.** Each commit = one build-sequence step OR one bug fix surfaced during a step.
- **Do not skip BUILD_LOG.** Append a dated entry per commit so the next session can resume cold.

## Useful commands

```bash
# Compile gate
pnpm -r build

# Layout sensor
pnpm --filter @devplusllc/harness check:layout

# Smoke suite (passing as of 2d99689)
pnpm --filter @devplusllc/harness smoke:session-start
pnpm --filter @devplusllc/harness smoke:status-line
pnpm --filter @devplusllc/harness smoke:handoff
pnpm --filter @devplusllc/harness smoke:scope-index
pnpm --filter @devplusllc/harness smoke:read-enrich
pnpm --filter @devplusllc/harness smoke:init
pnpm --filter @devplusllc/harness smoke:ingestion-baseline
pnpm --filter @devplusllc/harness smoke:tier0
pnpm --filter @devplusllc/harness smoke:gc
pnpm --filter @devplusllc/harness smoke:lock

# Pre-existing failures (NOT regressions from this build):
#   smoke:mcp                — harness_append not registered (predates this work)
#   smoke:decision-capture   — calls real Claude API; smoke not configured for offline run
```

## Open / deferred from this session

- **§19 spec — Q-1 source-comment cost ceiling**: operator picked "full" (no cap). Honor in step 7.
- **§19 spec — Q-2 direction-skill triggering**: locked as "auto-invoke + slash fallback `/harness-direction <prompt>`". Implement both in step 5.
- **smoke-mcp** broken pre-session — not a regression. Investigate during step 4 (plugin scaffold) since plugin's MCP registration may overlap.
- **harness-core/src/index.ts** still exports a few things from now-dormant modules (none — verified clean). If a consumer breaks during step 3b/3c, check `_dormant/` for the missing surface and either inline a minimal replacement in core or surface for the operator.

## End

Commit log to date:
```
2d99689 feat(lock): per-write flock for global state writes
e3366eb feat(tier0): replace Ollama with Claude binary (Haiku)
1b6fee1 chore(_dormant): mirror, voice, daemon-autostart off the build path
        chore(_dormant): move runtime + discord adapters off the build path
7c5f16c docs: plugin architecture spec
8456765 chore(docs): archive pre-pivot specs, build artifacts, research
5c65e15 chore(repo): unify packages, drop tracked tarballs, tidy gitignore
fcf4a87 chose: deep review pass + plugin-pivot handoff
```

Pick a step from the build sequence above and ask the operator to confirm before executing. Default suggestion: step 3b.
