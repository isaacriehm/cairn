---
type: handoff
generated: 2026-05-04
purpose: Resume prompt for a fresh Claude Code session continuing the plugin-pivot build
supersedes: harness-build/HANDOFF_PLUGIN_PIVOT.md
---

# Resume — plugin pivot build

You are a fresh Claude Code session continuing the harness plugin pivot. Read this top-to-bottom, then ask the operator which build-sequence step to execute next.

## TL;DR

The plugin architecture is fully specced and locked at `docs/PLUGIN_ARCHITECTURE.md`. Steps 1–6 of the build sequence are done. Steps 7–10 remain. Operator wants execution to be autonomous within each step — surface only genuinely load-bearing forks, not every minor fork.

## Load-bearing reads (in order)

1. **`docs/PLUGIN_ARCHITECTURE.md`** — the canonical spec. 600 lines, 19 sections. Everything below is cross-references into it.
2. **`AGENTS.md`** — table-of-contents for the project + operator profile.
3. **`harness-build/BUILD_LOG.md`** — append your work here on completion.
4. **Memory:** `~/.claude/projects/<project-key>/memory/MEMORY.md`. Especially:
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

## What's done

```
027c74d feat(plugin): reviewer subagent + harness_resolve_attention + stop scan        — step 6
af7ce6a feat(plugin): skills + slash commands                                          — step 5
070f5c9 feat(plugin): scaffold harness-frontend-claudecode + hook bin entrypoints      — step 4
940740a feat(events): invalidation events writer + per-session marker                  — step 3c
44cb1e0 feat(state): per-session state partition                                       — step 3b
d8baba1 docs: resume prompt for plugin-pivot build sequence
2d99689 feat(lock): per-write flock for global state writes                            — step 3a
e3366eb feat(tier0): replace Ollama with Claude binary (Haiku)                         — step 2
1b6fee1 chore(_dormant): mirror, voice, daemon-autostart off the build path            — step 1b
03588cd chore(_dormant): move runtime + discord adapters off the build path            — step 1a
```

(See `git log --oneline -16` for the full picture.)

### Concretely (cumulative state)

- **Repo unified** — five workspace packages live under `packages/*`. `pnpm-workspace.yaml` lists `packages/*`. `_dormant/` (root, outside workspace) holds runtime, discord adapter, voice/mirror submodules, dormant CLI subcommands.
- **Plugin spec written** — `docs/PLUGIN_ARCHITECTURE.md` is the authoritative source for everything. Cross-reference it; never reinvent.
- **Daemon killed.** **Ollama killed** (tier0 calls `runClaude` with Haiku tier + JSON-schema). **Lock module live** at `harness-core/src/lock.ts`.
- **Per-session state partition** — every Claude Code session owns `.harness/sessions/<session-id>/` with status.json, meta.json, events-marker.json. SessionStart creates + GCs stale (>24h or dead pid). SessionEnd cleanup. status-line writer/reader rewritten to per-session sig.
- **Invalidation events** — `.harness/events/<14-digit-ts>-<kind>.json` emitted by every locked write tool (record_decision, archive, drop_task, resolve_attention). McpContext.sessionId stamped onto every event. eventsSince filter+sort+malformed-tolerant; gcStaleEvents 7-day retention. Per-session marker arms watch at SessionStart; Stop hook stamps poll cursor.
- **Plugin package scaffolded** — `packages/harness-frontend-claudecode/` ships plugin.json, .mcp.json, hooks/hooks.json (SessionStart, SessionEnd, Stop, PostToolUse[Read|Grep|Glob, Write|Edit] all node-direct paths into harness-core dist). Skills (harness-adopt, harness-direction, harness-attention) + slash commands (/harness-init, /harness-direction) + agents/reviewer.md ship as markdown with frontmatter. Plugin's `pnpm build` runs `scripts/check-layout.mjs` validating manifest + bin paths + frontmatter shape.
- **Hook bin entrypoints** — `packages/harness-core/src/hooks/{session-start,session-end,stop,read-enrich,write-guard}.ts` compile to `dist/hooks/<event>.js`. Plugin manifest invokes `node ${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/hooks/<event>.js` directly — no dependency on `harness` umbrella CLI on PATH. MCP server bin at `dist/mcp/serve.js` (spec said `server.js`; diverged because `server.js` is the library export).
- **Stop hook** scans `.harness/tasks/active/<id>/` for tasks with `spec.tightened.md` but no `attestation.yaml` (≤6h window) and surfaces a "## Reviewer pending" hint in additionalContext referencing `agents/reviewer.md`.
- **`harness_resolve_attention` MCP tool** resolves the kind × choice matrix (decision_draft accept/reject/edit, baseline_finding triage/suppress/defer, invalidation_event refresh/continue/abort). Locked writes for accept/reject/suppress; emits invalidation events.
- **Reviewer subagent** at `agents/reviewer.md` — read-only on the working tree; emits ≤5 DEC drafts via `harness_record_decision({target:"inbox"})`; writes consolidated `attestation.yaml`.

## Active workspace

```
packages/
  harness/                          — umbrella + CLI bin (`harness init` + `harness hook X` + debug subcommands)
  harness-core/                     — state + MCP + tier0 + tightener + sensors + GC + hook runners + bin entrypoints
  harness-frontend-claudecode/      — Claude Code plugin (manifest + .mcp.json + hooks.json + skills + agents + commands)
  harness-frontend-stub/            — test adapter
  harness-lens/                     — VS Code/Cursor IDE extension
```

## Build sequence remaining

Per `docs/PLUGIN_ARCHITECTURE.md` §19. Each step is its own commit + BUILD_LOG entry + compile gate.

| Step | Title | Notes |
|------|-------|-------|
| 7 | Heavy adoption pipeline | Extend init Phase 6 — Phase 7b (full-repo source-comment ingestion: deterministic detect heuristic > 3 lines OR > 200 chars OR JSDoc with > 30 words; Haiku batch-classify 20 blocks/call into rationale/constraint/citation/license/other; suggested DEC drafts + §V proposals + canonical-map citations), Phase 7c (existing rules merge — `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/rules/` ingested + reconciled with harness state; post-adoption regenerates `CLAUDE.md` + `AGENTS.md` from ground state with `<!-- harness:keep-start -->`/`<!-- harness:keep-end -->` operator sections preserved), Phase 10 (deterministic strip + replace; uncommitted-changes pre-check + stash/skip/overwrite A/B/C; originals to `.harness/backups/source/<rel>.original`; per-module batch consent default + per-file escalation on `[b]`; mechanical replacement, never LLM-rewritten). Operator picked "full" cost ceiling — no cap on Haiku spend. |
| 8 | Multi-dev enforcement | Versioned git hooks at `.harness/git-hooks/pre-commit` + `commit-msg`; `core.hooksPath = .harness/git-hooks` set per-clone; paired post-commit hook appends attested SHA to `.harness/.attested-commits` (gitignored, per-clone); `.github/workflows/harness-check.yml` CI gate runs `harness sensor-run --diff origin/main..HEAD --strict` (non-bypassable); `.harness/JOIN.md` instructions for new contributors; `harness join` CLI bootstrap (verify CLI version, set core.hooksPath, install local session state); `package.json` `prepare` script `harness join \|\| true` for Node projects (best-effort detection during adoption Phase 1 for non-Node — Makefile/justfile/pyproject.toml). Plugin SessionStart degraded mode: MCP read-only, write tools return BOOTSTRAP_REQUIRED envelope, harness-direction blocks. Stop hook bypass detection compares HEAD's last 5 commits against `.attested-commits`; surfaces `[a] backfill / [b] accept (record DEC) / [c] defer`. |
| 9 | End-to-end smoke | Install plugin into a fresh test project (clean fixture, NOT sample-project — content audit is part of step 10), run full adoption (every phase), verify daily flow with a small task end-to-end (operator prompt → harness-direction skill → tightener → dispatch → reviewer attest → DEC drafts in attention queue), confirm Stop hook surfaces correctly. Regression-clean smokes against the host repo too. |
| 10 | Pre-publish prep | gitleaks scan; content audit (sample-project references in BUILD_LOG, archives, _research/); operator decides on history wipe; fresh public repo with current clean working tree as initial commit at `v0.1.0`; private repo retained as backup. Manual step, not automated. |

## How to start

1. Read this file end-to-end.
2. Read `docs/PLUGIN_ARCHITECTURE.md` end-to-end (focus §6 phases for step 7; §17 layers for step 8).
3. Verify the build is clean:
   ```bash
   pnpm install
   pnpm -r build
   pnpm --filter @isaacriehm/harness check:layout
   ```
4. Run the smoke suite to confirm no regressions:
   ```bash
   for s in plugin-layout resolve-attention stop-hook events session-state status-line session-start handoff scope-index read-enrich init ingestion-baseline tier0 gc lock; do
     pnpm --filter @isaacriehm/harness "smoke:$s" 2>&1 | tail -2
   done
   ```
5. Confirm to the operator in 2-3 lines what you've loaded. Ask which build-sequence step to execute next (default suggestion: step 7 — heavy adoption pipeline).
6. Match the operator's terse-direct caveman-ultra style for chat replies. Documents stay full English.

## Hard rules

- **Do not invent decisions.** All architecture is in `docs/PLUGIN_ARCHITECTURE.md`. If something seems missing, re-read first; if genuinely undefined, surface as a single load-bearing question to the operator.
- **Do not over-prompt.** Memory file `feedback_decide_dont_overprompt.md` documents the operator's pushback on this. Cap surfaced questions to ≤2-3 per round, all genuinely load-bearing.
- **Do not revive dormant code.** `_dormant/` exists for a reason — its revival is a future operator decision, not something to undo as a side-effect of build work.
- **Do not write env vars.** Operator hates them. Hardcode model IDs in code, paths in code.
- **Do not add backward-compat shims.** Hard cutovers only. If a refactor breaks something, fix the consumer, don't leave a transitional layer.
- **Do not commit without an explicit `pnpm -r build` pass.** Compile gate is non-negotiable.
- **Do not merge unrelated work.** Each commit = one build-sequence step OR one bug fix surfaced during a step.
- **Do not skip BUILD_LOG.** Append a dated entry per commit so the next session can resume cold.
- **Do not use PreToolUse hooks.** Bricks the session. SessionStart instructions + MCP tools only.

## Useful commands

```bash
# Compile gate
pnpm -r build

# Layout sensor
pnpm --filter @isaacriehm/harness check:layout

# Smoke suite (15 passing as of 027c74d)
pnpm --filter @isaacriehm/harness smoke:plugin-layout
pnpm --filter @isaacriehm/harness smoke:resolve-attention
pnpm --filter @isaacriehm/harness smoke:stop-hook
pnpm --filter @isaacriehm/harness smoke:events
pnpm --filter @isaacriehm/harness smoke:session-state
pnpm --filter @isaacriehm/harness smoke:status-line
pnpm --filter @isaacriehm/harness smoke:session-start
pnpm --filter @isaacriehm/harness smoke:handoff
pnpm --filter @isaacriehm/harness smoke:scope-index
pnpm --filter @isaacriehm/harness smoke:read-enrich
pnpm --filter @isaacriehm/harness smoke:init
pnpm --filter @isaacriehm/harness smoke:ingestion-baseline
pnpm --filter @isaacriehm/harness smoke:tier0
pnpm --filter @isaacriehm/harness smoke:gc
pnpm --filter @isaacriehm/harness smoke:lock

# Direct-spawn hook bins (sanity)
echo '{"session_id":"x","cwd":"/tmp/notharness"}' | node packages/harness-core/dist/hooks/session-start.js
echo '{"session_id":"x","cwd":"/tmp/notharness"}' | node packages/harness-core/dist/hooks/stop.js
echo '{"session_id":"x","cwd":"/tmp/notharness"}' | node packages/harness-core/dist/hooks/session-end.js

# Pre-existing failures (NOT regressions from this build):
#   smoke:mcp                — harness_append not registered (predates this work)
#   smoke:decision-capture   — calls real Claude API; smoke not configured for offline run
```

## Open / deferred

- **§19 spec — Q-1 source-comment cost ceiling**: operator picked "full" (no cap). Honor in step 7.
- **smoke-mcp** broken pre-session — not a regression. Worth a quick look during step 7 since the plugin's MCP path now points to `dist/mcp/serve.js` (different from what the smoke expects).
- **MCP server path divergence**: spec text says `dist/mcp/server.js`; we ship `dist/mcp/serve.js` (server.js is the library export, can't auto-execute on import). Documented in BUILD_LOG step 4 entry.
- **Reviewer subagent integration with main Claude**: stop hook surfaces a text hint; main Claude on the next turn is responsible for issuing the Task call. No automatic spawn — verified working manually but step 9 should exercise the full loop.
- **harness_resolve_attention NOT yet wired into harness-attention skill**: skill body documents the fallback path (record_decision/archive/append) until it picks up the new tool. Update the skill in step 9 once the end-to-end loop is exercised.

## Plugin layout reference

```
packages/harness-frontend-claudecode/
├── .claude-plugin/
│   └── plugin.json                  — name=harness, version=0.1.0
├── .mcp.json                        — `node ${CLAUDE_PLUGIN_ROOT}/../harness-core/dist/mcp/serve.js`
├── hooks/
│   └── hooks.json                   — SessionStart, SessionEnd, Stop, PostToolUse[Read|Grep|Glob, Write|Edit]
├── skills/
│   ├── harness-adopt/SKILL.md       — first-time adoption walk
│   ├── harness-direction/SKILL.md   — task → tier0 → tightener → dispatch
│   └── harness-attention/SKILL.md   — pending DEC drafts + drift + invalidation events
├── commands/
│   ├── harness-init.md              — manual /harness-init
│   └── harness-direction.md         — manual /harness-direction <prompt>
├── agents/
│   └── reviewer.md                  — last-step subagent; reads diff + attestation files
├── scripts/check-layout.mjs         — package's `pnpm build` (validates manifest + frontmatter)
├── package.json                     — workspace member; depends on harness-core
└── README.md
```

## Hook entrypoints reference

```
packages/harness-core/dist/hooks/
├── session-start.js     — node bin; invokes runSessionStartHook
├── session-end.js       — node bin; invokes runSessionEndHook
├── stop.js              — node bin; invokes runStopHook (events drain + reviewer scan + heartbeat)
├── read-enrich.js       — node bin; invokes runReadEnricher
├── write-guard.js       — node bin; invokes runWriteGuardian
└── runners/             — pure runner functions called by both bins + umbrella CLI
```

## End

Pick a step from the build sequence above and ask the operator to confirm before executing. Default suggestion: **step 7 — heavy adoption pipeline**.
