---
type: spec
status: draft
generated: 2026-05-04
supersedes-parts-of: ARCHITECTURE.md, INIT_SPEC.md, MCP_SURFACE.md, FILESYSTEM_LAYOUT.md
purpose: Lock the plugin form factor — adoption, daily flow, state, concurrency, distribution
---

# Plugin Architecture — `cairn-frontend-claudecode`

> **This is a technical implementation spec.** If you're trying to *use*
> Cairn rather than modify it, start with the user guide:
> [Adopting Cairn](guide/adoption.md) and [Using Cairn day to day](guide/daily-flow.md).

The plugin pivot: Cairn is shipped as a Claude Code plugin. The operator installs once at user level. From then on, opening Claude Code in any project activates Cairn. After a one-time visual adoption pass, Cairn runs invisibly — surfacing only via inline A/B/C prompts when it needs operator input.

## §1 Vision

Cairn becomes the **project maintainer**. After install + adoption, the operator just uses Claude Code normally and Cairn:

1. Intercepts vague prompts, asks **genuinely good questions** (not UX trivia) about forks that materially change the spec.
2. Tightens the prompt into a structured spec via iterative dialogue.
3. **Chunks complex tasks** and dispatches them as Claude Code subagents — each subagent inherits MCP tools and reads the tightened spec.
4. **Reviews and attests** at task completion via a bundled reviewer subagent.
5. **Enforces constraints** at two gates: plugin Stop hook (in-session early signal) + pre-commit git hook (canonical backstop).
6. **Captures decisions** the reviewer surfaces from the diff, drafts to the inbox, surfaces inline next session.
7. **Detects drift** between ground state and the working tree (GC sweep), surfaces remediation inline.

Operator never types `cairn <subcommand>` for ongoing work. Only `cairn init` (terminal-side bootstrap) remains as a CLI surface; the in-Claude-Code path is the `/cairn-init` slash command + the auto-invoked `cairn-adopt` skill.

## §2 Form factor + agnosticism

Claude Code is the **primary** frontend. The layered architecture preserves platform agnosticism: `cairn-core` remains pure state + MCP server (any MCP client works). Frontends are sibling packages. Future Cursor / Copilot / Windsurf / etc. integrations become additional sibling packages — `cairn-frontend-cursor`, `cairn-frontend-copilot` — without rewriting the core.

Single-vendor lock-in is rejected at the architecture level even while we ship Claude Code as the only live frontend in v0.

## §3 Package layout

```
packages/
  cairn/                              — umbrella + CLI bin (`cairn init`, `cairn join`, `cairn hook X`, …)
  cairn-core/                         — state + MCP + sensors + GC + hook runners + init pipeline
  cairn-frontend-claudecode/          — Claude Code plugin (.claude-plugin/plugin.json)
  cairn-lens/                         — VS Code / Cursor IDE extension (parallel surface)
```

The daily-flow question-asker and spec-tightener are no longer
backend modules — they were purged in v0.2.1 and replaced by the
`cairn-direction` skill, where main Claude does the routing +
tightening live (see `docs/SYSTEM_OVERVIEW.md` §10).

`pnpm-workspace.yaml` lists `packages/*`. There are no dormant trees in
the public repo.

## §4 Plugin manifest + components

Lives at `packages/cairn-frontend-claudecode/`:

```
packages/cairn-frontend-claudecode/
├── .claude-plugin/
│   └── plugin.json                   — manifest (name, version, repo, etc.)
├── .mcp.json                         — registers cairn-core MCP server (stdio)
├── hooks/
│   └── hooks.json                    — SessionStart, Stop, PostToolUse[read-enrich]
├── skills/
│   ├── cairn-adopt/SKILL.md          — first-time adoption flow
│   ├── cairn-direction/SKILL.md      — prompt → tier0 → tightener → dispatch
│   └── cairn-attention/SKILL.md      — surface pending DEC drafts + drift inline
├── commands/
│   └── cairn-init.md                 — slash command equivalent of `cairn init`
├── agents/
│   └── reviewer.md                   — subagent definition for attestation + DEC capture
└── package.json                      — workspace package, depends on cairn-core
```

Component locations follow Claude Code's auto-discovery defaults (`skills/`, `commands/`, `agents/` at plugin root). MCP and hooks declared via dedicated files (`.mcp.json`, `hooks/hooks.json`) rather than inline in `plugin.json` for editability.

`plugin.json` minimum:

```json
{
  "name": "cairn",
  "version": "0.1.0",
  "description": "Project-state + context-loading layer — the invisible project maintainer",
  "author": { "name": "Isaac Riehm" },
  "repository": "https://github.com/isaacriehm/cairn",
  "license": "MIT"
}
```

`userConfig` field unused in v0. All operator config lives in per-project `.cairn/config/`.

## §5 Distribution

- **v0 → v1**: GitHub URL distribution.
  - User runs `/plugin marketplace add isaacriehm/cairn` once
  - Then `/plugin install cairn@isaacriehm-cairn`
  - Tag `v0.1.0`, `v0.2.0`, … on each release; users pull via `/plugin update cairn@isaacriehm-cairn`
- **v1.0.0 milestone**: evaluate moving to the official Anthropic plugin marketplace for first-class discovery + auto-update by default.

Pre-publish (operator's call, not now): wipe history + push current clean working tree as the initial commit of the public repo. The private repo stays as authoritative dev backup.

Auto-update is OFF by default for github-distributed plugins. Operator can enable per-marketplace via the `/plugin` UI.

## §6 Adoption flow — one-time, super visual, comprehensive

Three trigger paths converge on the same pipeline:

1. **Auto** — operator opens Claude Code in a project with no `.cairn/`. Plugin's SessionStart hook detects, the `cairn-adopt` skill auto-invokes and renders inline:
   > Adopt this project with Cairn? `[a]` yes `[b]` not now `[c]` never (mark and skip on future opens)
2. **Explicit slash command** — operator types `/cairn-init`.
3. **Terminal CLI** — operator runs `cairn init` outside Claude Code. Same pipeline.

On `[a]`, the skill (or CLI) spawns the init pipeline as a subprocess and **streams its rich terminal output (chalk + ora + cli-progress) into the Claude Code conversation as a fenced code block** — the visual approach (α). Choices that need operator input surface as inline A/B/C via the skill calling Claude Code's AskUserQuestion tool.

### Phases (v0.5.0+)

| Phase | What happens | Visible to operator |
|------|--------------|---------------------|
| 1 | Detect environment + stack signatures | "Detecting environment…" → signals |
| 2 | Priority walker (repo summary scan) | Tree silhouette, file counts |
| 3 | Sonnet domain mapper (chunked, parallel) | Per-module status icons updating live |
| 4 | Seed `.cairn/` skeleton + grandfather commits | "Writing .cairn/ skeleton" |
| 5 | Pilot module confirm | One A/B/C: pick pilot module |
| 6 | Brand auto-fill (Haiku) | One A/B/C: consent to auto-fill brand |
| 7 | Topic index build (dedup pre-pass) | "Building topic index…" → block counts |
| 8 | **Docs ingestion** (README + docs/) | Per-doc status icons; DEC draft count |
| 9 | **Source comment ingestion** (essay-class) | Per-batch status; DEC + §INV counts |
| 10 | **Existing project rules merge** (CLAUDE.md) | "Merging project rules…" → diff summary |
| 11 | Baseline sensor audit | Per-sensor status; finding counts |
| 12 | **Comment policy enforcement** (strip) | Per-module preview + A/B/C consent |
| 13 | Multi-dev enforcement install + summary | "Installed git hooks + CI gate" → summary |

After this single pass, Cairn IS the project maintainer. Source files are clean (only `// §INV-NNNN` and `// TODO(TSK-)` cites). All prior decisions are canonicalized. Existing rules are merged. Sensors are baselined. Inconsistencies are resolved or queued.

## §7 State model

Three storage zones:

| Zone | Location | Owner | Lock |
|------|----------|-------|------|
| **Global** | `.cairn/ground/` (decisions, invariants, canonical-map, brand, quality-grades), `.cairn/baseline/`, `.cairn/inbox/` | shared across sessions | per-write `flock` on `.cairn/.write-lock` |
| **Per-session** | `.cairn/sessions/<session-id>/` (status.json, current task, run notes) | one session | none — owned by session |
| **Plugin-internal** | `${CLAUDE_PLUGIN_DATA}/` (cache, telemetry, adopted-projects index) | plugin | none |

Session ID generated at plugin SessionStart (Claude Code session id if exposed, else uuid). Cleanup at SessionEnd. Stale sessions (> 24h, no live PID) GC'd by next SessionStart in any session.

### Concurrency

- **Per-write `flock`** on `.cairn/.write-lock` for any global-state write. OS-level — auto-release on process crash. Reads unlocked.
- **Whole-operation locks** on `.cairn/.gc-lock` and `.cairn/.audit-lock` for sweep operations. Second concurrent sweep bails fast with "another in progress".
- **DEC ID allocation** atomic under the per-write lock. Two sessions calling `cairn_record_decision` get distinct DEC-NNNN values.
- **Invalidation events**: when a global write completes, Cairn writes `.cairn/events/<ts>-<event>.json`. Plugin instances poll the events directory at Stop hook (chokidar file watcher armed, debounced). If an event touches a DEC/§INV in the current session's in-scope set → surface inline:
  > A modified DEC-0042 (which you're using). `[a]` refresh in-scope `[b]` continue under old `[c]` abort

Default `[a]`. Event log retention: last 7 days, GC'd by sweep.

### Three-layer conflict catch

When two sessions race on a decision used by both:

1. **Live reads** — every MCP read tool re-reads state from disk. No frozen session snapshot. Next call returns post-A state.
2. **Invalidation events + inline A/B/C** — early signal.
3. **Pre-commit gate** — sensors run against current ground state, catches stale code at commit.

After-the-fact (B already committed when A modifies the DEC): GC drift sweep flags the file as drift, surfaces in attention as A/B/C "update file / revert DEC / accept divergence (record as new DEC)".

## §7.5 No daemon — state freshness contract

State freshness is event-driven, not wall-clock-driven. Every stateful operation runs on a discrete trigger; no sidecar process watches the tree.

| Trigger | What runs | Where |
|---------|-----------|-------|
| **SessionStart** | Manifest rebuild, in-scope refresh, status partition seed, statusline shim sync | `packages/cairn-core/src/hooks/runners/session-start.ts` |
| **Stop** | Events drain, drift / bypass / reviewer-pending scan, status heartbeat | `packages/cairn-core/src/hooks/runners/stop.ts` |
| **Pre-commit hook** (per-clone) | Sensor sweep against the staged diff; HEAD attestation on success | `.cairn/git-hooks/pre-commit` |
| **Post-commit hook** (per-clone) | Append SHA to `.cairn/.attested-commits`; emit invalidation events for ledger touches | `.cairn/git-hooks/post-commit` |
| **CI** | Sensor sweep + version-sync gate + bootstrap-required gate | `.github/workflows/cairn-check.yml` |
| **GC sweep** | Stale `_inbox/` drafts, drift detection, decision-to-symbol re-index | `cairn gc` (manual or invoked by Stop when overdue) |

**Stale state never blocks anything dangerous.** The session-boundary contract is: between two SessionStarts (or between a SessionStart and the next Stop), state can grow stale, but no destructive operation runs against the stale view. Sensor sweeps against the live tree at commit time; in-scope DECs/§INVs are re-read by the MCP read tools on every call. The result is "eventually consistent" — fast for the operator, no background process, drift caught at the next session boundary.

## §8 Daily flow (post-adoption)

```
Operator types prompt
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ cairn-direction skill (auto-invoked on user message)    │
│   1. tier0 (Haiku via Claude binary, escalate to Sonnet │
│      for complexity) — checks readiness                 │
│         Inputs: prompt + in-scope decisions/invariants  │
│                 + canonical-map topics + recent commits │
│         Output: { ready: bool, questions[] | spec_seed }│
│   2. If ready=false → render inline A/B/C questions     │
│      via AskUserQuestion. After answers, loop.          │
│   3. If ready=true → tightener (Sonnet) produces        │
│      .cairn/tasks/active/<id>/spec.tightened.md         │
│   4. Tightener proposes chunks:                         │
│         1 chunk → silent dispatch (no prompt)           │
│         ≥2 chunks → A/B/C plan review:                  │
│           "Plan: 3 subagents — [auth] [billing] [tests] │
│            [a] dispatch all [b] modify [c] cancel"      │
└─────────────────────────────────────────────────────────┘
        │
        ▼
Main Claude spawns subagents via Task tool
   - Each subagent inherits Cairn MCP tools
   - Reads spec.tightened.md + queries `cairn_in_scope`
   - Works in main repo (no mirror, no runtime checkout)
        │
        ▼
Reviewer subagent fires LAST
   - Reads diff, sensors output, attestation.yaml from each subagent
   - Surfaces non-obvious choices as DEC drafts → _inbox/
   - Returns attestation summary
        │
        ▼
Stop hook (plugin) — fires when assistant turn ends
   - Run sensors on diff (staged + unstaged)
   - If findings → surface inline A/B/C
   - Poll invalidation events; if relevant → surface refresh prompt
   - If new DEC drafts → surface "review N pending decisions? [a/b/c]"
        │
        ▼
Operator commits → pre-commit git hook (canonical backstop)
   - Layer A (stub catalog) + decision-assertions on staged diff
   - Hard fail blocks commit, soft warn passes
```

PostToolUse hook on `Read`/`Grep`/`Glob` enriches tool results with citation legend (§INV references + relevant DEC summaries). Banned: PreToolUse (bricks session per prior anti-pattern).

## §9 MCP surface

Per-session stdio MCP server. `.mcp.json` registration:

```json
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/../cairn-core/dist/mcp/server.js"]
    }
  }
}
```

The MCP server detects the project root at startup by walking up from `process.cwd()` until it finds either `.cairn/` or `.git/`. No env var dependency. Works in any project Claude Code opens.

Tools (18 current, see `MCP_SURFACE.md` for full schema):

- **Read**: `cairn_decision_get`, `cairn_in_scope` (unified DEC+INV path-glob lookup; filter via `types: ["decision"|"invariant"]`), `cairn_decisions_for_symbol`, `cairn_invariant_get`, `cairn_canonical_for_topic`, `cairn_ground_get`, `cairn_supersedes_chain`, `cairn_search`, `cairn_timeline`, `cairn_get_full`, `cairn_query_history`
- **Write** (locked): `cairn_record_decision`, `cairn_record_run_event`, `cairn_drop_task`, `cairn_archive`, `cairn_append`, `cairn_ask_operator`
- **NEW (plugin-era)**: `cairn_resolve_attention(item_id, choice)` — the inline-A/B/C resolution endpoint. Skill calls this after operator picks a/b/c.

Write tools wrap their work in the per-write flock helper from `cairn-core/src/lock.ts` (new module).

## §10 Hooks

`hooks/hooks.json`:

```json
{
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/../cairn-core/dist/hooks/session-start.js\""
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/../cairn-core/dist/hooks/stop.js\""
        }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "Read|Grep|Glob",
      "hooks": [
        {
          "type": "command",
          "command": "node \"${CLAUDE_PLUGIN_ROOT}/../cairn-core/dist/hooks/post-tool-use/read-enricher.js\""
        }
      ]
    }
  ]
}
```

| Hook | Job |
|------|-----|
| `SessionStart` | Build handoff context (git diff since last session, in-scope decisions/invariants, brand/positioning); detect adoption state (has `.cairn/`?); detect attention (pending DEC drafts, baseline findings, drift) and stage the session to auto-invoke `cairn-attention` skill if non-zero; clean up stale per-session state directories |
| `Stop` | (1) Run sensors on staged + unstaged diff; surface findings inline. (2) Poll `.cairn/events/` for invalidation events touching session's in-scope; surface refresh prompt if any. (3) Scan `.cairn/tasks/active/<id>/` for tasks created this session without `attestation.yaml`; if any → spawn reviewer subagent to attest. (4) Compare HEAD's last 5 commits against `.cairn/.attested-commits` marker file; surface backfill prompt for any commit that bypassed pre-commit hook (i.e. `--no-verify`). (5) Update per-session `status.json` |
| `PostToolUse` (Read/Grep/Glob) | Citation enrichment — inject §INV references + decision summaries into the tool result text |
| `PreToolUse` | **BANNED** — bricks the session if the hook fails. Never use. |

## §11 Skills + subagents + slash commands

| Surface | Path | Trigger | Job |
|---------|------|---------|-----|
| Skill | `skills/cairn-adopt/SKILL.md` | SessionStart sees no `.cairn/` | Walks operator through adoption inline; orchestrates init pipeline subprocess |
| Skill | `skills/cairn-direction/SKILL.md` | Auto-invoked when operator's user message looks like a task ("build…", "add…", "fix…", "refactor…") and there's no active task | Runs tier0 → tightener → dispatch chunks via Task tool |
| Skill | `skills/cairn-attention/SKILL.md` | SessionStart context flagged `attention_count > 0` | Surfaces pending DEC drafts + drift + baseline findings as inline A/B/C; calls `cairn_resolve_attention` after each pick |
| Subagent | `agents/reviewer.md` | Spawned by main Claude as the LAST step of any non-trivial task | Reads diff + sensor outputs + attestation files; extracts non-obvious DECs; returns attestation summary |
| Slash command | `commands/cairn-init.md` | Operator types `/cairn-init` | Same as auto-adopt skill but explicitly invoked |
| Slash command | `commands/cairn-direction.md` | Operator types `/cairn-direction <prompt>` | Manual invocation of the direction skill — escape hatch when auto-invoke misses (conversational message wrongly classified, or operator wants to force the question-asker on a borderline prompt) |

Skill `description` frontmatter is what triggers auto-invocation. Example for `cairn-direction`:

```yaml
---
description: |
  Use when the user gives a task-shaped prompt (build, add, fix, refactor,
  implement, change). Runs tier0 question-asker → tightener spec writer →
  Claude Code subagent dispatch with constraint context. Skip for
  questions, conversation, or read-only requests.
---
```

### Subagent dispatch protocol

The `cairn-direction` skill produces a structured **dispatch block** that main Claude reads and turns into Task-tool calls. Skill output ends with:

````markdown
## Dispatch plan

Tightened spec: `.cairn/tasks/active/<task-id>/spec.tightened.md`
Reviewer: spawn LAST after all dispatched subagents complete.

```dispatch
- subagent: general-purpose
  brief: |
    Read .cairn/tasks/active/<task-id>/spec.tightened.md.
    Implement the auth middleware portion (files: services/auth/*.ts).
    Cite §INV-0042, §INV-0043 in any new code. Write attestation.yaml on completion.
- subagent: general-purpose
  brief: |
    Read the same spec.
    Implement the billing portion (files: services/billing/*.ts).
    Cite §INV-0012. Write attestation.yaml.
```
````

Skill description instructs main Claude: "After receiving this skill's output, parse the `dispatch` block. Spawn one Task call per entry, in parallel where possible. Then spawn the reviewer subagent." This is reliable enough in practice; if drift becomes a problem, escalate to a deterministic post-skill hook that issues the Task calls directly.

For 1-chunk dispatches, the skill omits the `dispatch` block and just hands the spec to main Claude with "implement this directly".

## §12 Authority matrix

| Surface | Plugin authority |
|---------|------------------|
| `.cairn/ground/` (own state) | Full auto |
| `.cairn/sessions/<id>/` (own per-session state) | Full auto |
| Source files (comment strips, §INV cites) | A/B/C per module-batch with per-file escalation on reject |
| Existing docs (consolidation, rewrites) | A/B/C per doc or batch |
| `~/.claude/settings.json` (`enabledPlugins` map only) | Auto on `/plugin install` |
| Project's `.claude/settings.json` | **Never written.** Plugin's contributions merge at runtime |
| Pre-commit git hook install | Full auto |
| Soft inconsistencies (scope/phrasing) | Defer to attention |
| Hard inconsistencies (factual contradictions) | Block adoption, A/B/C inline per conflict |
| Auto-resolution of any kind | Forbidden — operator decides every contested change |

## §13 Inconsistency handling during adoption

**Hard conflicts** — factual contradictions between decisions / docs / source comments. Example: `docs/auth.md` says "JWT expires in 24h"; `services/auth.ts` comment says "JWT expires in 7d". Adoption blocks. Inline A/B/C:

> Conflict: JWT expiry. `docs/auth.md` says 24h. `services/auth.ts:42` comment says 7d. Which is canonical?
> `[a]` 24h (file: docs/auth.md) `[b]` 7d (file: services/auth.ts) `[c]` neither — capture as new DEC

**Soft conflicts** — scope/phrasing differences, possibly intentional layering. Adoption completes. Conflicts written to `.cairn/inbox/conflicts/<id>.yaml`. First post-adoption attention pass surfaces them.

## §14 Question-asker quality

tier0's job is to detect **forks that materially change the spec**, not UX trivia.

| Bad question | Why bad |
|--------------|---------|
| "What color should the button be?" | UX trivia, not a fork |
| "Should this be a function or class?" | Style, not a constraint fork |
| "Do you want tests?" | Inferable from project policy / DECs |

| Good question | Why good |
|---------------|---------|
| "You said 'add billing'. Per DEC-0019 Stripe is the only payment processor. Adding a new product to the existing integration `@/services/stripe`, or replacing it with something else?" | References existing constraint; identifies fork; asks about something that materially changes the spec |
| "You said 'make X faster'. The current bottleneck is the BullMQ queue depth (per RUN-0042 perf trace). Optimize queue throughput, or change the architecture (e.g., direct execution)?" | Cites recent evidence; offers a fork the operator likely has an opinion on |

tier0 inputs:
- Operator prompt
- In-scope decisions for the prompt's apparent target paths
- Top 5 invariants by relevance
- Canonical-map topics that match prompt keywords
- Last 5 commits' messages (recent context)

tier0 output is JSON: `{ ready: boolean, questions?: Question[], spec_seed?: string }`. Auto-escalate to Sonnet when prompt > 500 tokens or touches > 10 decisions.

## §15 Comment policy enforcement

**Two legal citations** in source files:

- `// §INV-NNNN` — invariant reference
- `// TODO(TSK-<id>)` — linked task

Banned: DEC-id comments, essay JSDoc, multi-paragraph rationale, restated requirements.

### Three stages, with strict LLM/deterministic split

| Stage | LLM? | What happens |
|-------|------|--------------|
| **Detection** | **No** — deterministic | Walker finds essay-style comment blocks via heuristic: block comment > 3 lines OR > 200 chars OR JSDoc with > 30 words of prose. Per-language tweaks (Python `"""…"""`, Rust `///`, Go `//`, etc.) |
| **Extraction** | **Yes** — Haiku batch | 20 detected blocks per Haiku call → JSON: `{ block_id, type: "rationale" | "constraint" | "citation" | "license" | "other", suggested_dec_draft?, suggested_invariant?, suggested_canonical_topic? }`. License headers + "other" left in source untouched |
| **Replacement** | **No** — deterministic | Mechanical string substitution: strip the original block, insert `// §INV-NNNN` (if §INV exists or was just proposed) or `// TODO(TSK-<id>)` (if linked to active task). Never LLM-rewritten |

### Pre-write safety checks

Before any source file is modified during Phase 10:

1. **Uncommitted-changes check** — `git status --porcelain` on the file. If dirty:
   > `services/auth.ts` has uncommitted changes. Replacing comments would mix into your work-in-progress. `[a]` stash and process `[b]` skip this file `[c]` overwrite (lose uncommitted changes — destructive)
2. **Backup** — copy `services/auth.ts` → `.cairn/backups/source/services/auth.ts.original` (preserves directory structure). One backup per file, single snapshot. Used by `cairn uninstall --full` to restore.
3. **Diff preview** — generate the proposed diff and show in the per-module batch consent prompt before any write.

### Consent flow

**Per-module batch (default):**

> Module `core/auth` has 23 essay-style comment blocks. Extracted: 8 DEC drafts, 3 §INV candidate invariants. Diff preview: [collapsible].
> `[a]` strip all (review extractions in `_inbox/`) `[b]` review per-file (escalation) `[c]` skip module

**Per-file escalation when operator picks `[b]`:**

> `services/auth.ts:42-78` — 24-line JSDoc on JWT signing rationale. Extracted as DEC-draft-0042 + §INV-0042 invariant proposal. Replacement: `// §INV-0042`. Diff: [collapsible].
> `[a]` apply `[b]` keep as-is `[c]` modify (open in editor)

If the file has uncommitted changes the per-file prompt also shows the dirty-file warning.

### Post-adoption ongoing capture

Reviewer subagent extracts DEC drafts from new essay-style comments the operator writes during normal work, surfacing in next session's attention pass. Same three-stage split: deterministic detection, LLM extract, deterministic replace (only when operator approves). Same backup convention.

## §16 Uninstall

Two operations, distinct intents:

| Command | What it does | Reversible? |
|---------|--------------|-------------|
| `cairn uninstall` | Stops active enforcement only: removes `core.hooksPath` config, removes `.github/workflows/cairn-check.yml`, removes `package.json` `prepare` script entry. Leaves `.cairn/` directory + stripped comments + `.cairn/git-hooks/` intact. | **Yes** — re-enable via `cairn join` or plugin re-adopt |
| `cairn uninstall --full` | Full de-adoption: above + restores all stripped source comments from `.cairn/backups/source/*.original` (verified file-by-file; warns on missing or modified backups), deletes `.cairn/`, removes `.cairn/git-hooks/`, removes `JOIN.md`, removes plugin's project entry from `${CLAUDE_PLUGIN_DATA}/projects.json`. Asks confirmation: "this is irreversible. proceed?" `[a]` yes `[b]` no | **No** — fresh adoption required to re-enable |

The split mirrors how plugin disable (`/plugin disable cairn`) is per-user (just stops the plugin) vs full plugin uninstall (`/plugin uninstall cairn`) which removes user-level state. `cairn uninstall` is per-project light; `cairn uninstall --full` is per-project complete.

## §17 Multi-developer enforcement

Once a project is Cairn-adopted, every developer who touches it must be running Cairn — locally and at PR time. A second developer cloning the repo without Cairn installed must be **blocked from contributing** until they bootstrap. Defense in depth across four layers:

### Layer 1 — Versioned git hooks (catches local commits)

Adoption commits the pre-commit hook to the repo at `.cairn/git-hooks/pre-commit` (versioned, reviewable, diff-able). The hook is **not** placed in `.git/hooks/` directly — that path is per-clone and not versioned, so dev2's clone wouldn't get it.

Instead, adoption configures `git config core.hooksPath .cairn/git-hooks` so git uses the versioned hook dir. This config IS per-clone (lives in `.git/config`), so it must be set on every clone via the bootstrap step (Layer 2).

The hook script itself is short and resilient:

```sh
#!/usr/bin/env bash
set -e
if ! command -v cairn > /dev/null 2>&1; then
  echo "✗ Cairn CLI not on PATH"
  echo "  This project requires Cairn. Install:"
  echo "    /plugin install cairn@isaacriehm-cairn   (Claude Code)"
  echo "    npm install -g @isaacriehm/cairn            (CLI)"
  echo "  Or: rm .cairn/  to opt the project out (irreversible)"
  exit 1
fi
exec cairn sensor-run --staged "$@"
```

So if Cairn CLI is missing, commit fails with clear instructions. No silent bypass.

**Bypass tracking** — when the hook completes successfully, it appends the about-to-be-committed SHA (from `git rev-parse --verify HEAD@{0}` post-commit, via a paired `post-commit` hook) to `.cairn/.attested-commits` (gitignored, per-clone). The Stop hook compares HEAD's last 5 commit SHAs against this file; any commit not in the attested set is a bypass candidate. Surfaces inline:
> Commit `abc1234` ("…") was not attested by Cairn (likely `git commit --no-verify`). Run `cairn sweep` to backfill sensor results, or accept divergence?
> `[a]` backfill `[b]` accept (record as DEC: "intentional bypass — reason?") `[c]` defer

### Layer 2 — Per-clone bootstrap

When dev2 clones the repo for the first time, they need a one-time bootstrap to:

1. Verify Cairn CLI is installed (and its version is compatible with the project's Cairn state)
2. Set `core.hooksPath = .cairn/git-hooks` on the local clone
3. Optionally install local Cairn session state directory

Three trigger paths:

- **Plugin auto-detect**: dev2 opens project in Claude Code with the Cairn plugin enabled. Plugin's SessionStart sees `.cairn/` exists but `core.hooksPath` is unset (or Cairn CLI version mismatch). Auto-renders inline blocking A/B/C:
  > This project uses Cairn, but your clone isn't bootstrapped. Without it, your commits will fail. `[a]` bootstrap now (one-time, ~5s) `[b]` skip (commits will fail until you bootstrap)
- **Package-manager `prepare` hook**: for Node projects, adoption adds to `package.json`:
  ```json
  { "scripts": { "prepare": "cairn join || true" } }
  ```
  Runs on every `npm install` / `pnpm install`. `cairn join` checks state, runs bootstrap, idempotent. Fails soft (`|| true`) so missing Cairn during install doesn't break the install — the failure surfaces at first commit attempt instead.
- **Manual**: `cairn join` CLI command. Documented in the auto-generated `.cairn/JOIN.md` that adoption writes (visible at repo root, instructs new contributors).

For non-Node projects (Python, Go, Rust), adoption writes equivalent into `Makefile`, `justfile`, `pyproject.toml` `[tool.poetry] scripts`, etc. — best-effort detection during adoption Phase 1.

### Layer 3 — CI / server-side gate (non-bypassable)

Adoption ships a CI workflow (`.github/workflows/cairn-check.yml` for GitHub-hosted repos, equivalent for GitLab/Bitbucket). Workflow runs on every PR:

```yaml
name: cairn-check
on: [pull_request, push]
jobs:
  cairn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @isaacriehm/cairn
      - run: cairn sensor-run --diff origin/main..HEAD --strict
```

Fails the PR if any sensors fail or attestation is missing. **Non-bypassable** — even if dev2 used `git commit --no-verify` to skip the local hook, the CI gate catches it at PR time and the PR can't merge.

This is the canonical enforcement layer. Layers 1 and 2 are conveniences (fail fast at dev's machine) but Layer 3 is the contract.

### Layer 4 — Plugin SessionStart bootstrap-required block (Claude Code users)

Beyond just commit blocking: if dev2 opens the Cairn-adopted project in Claude Code with the Cairn plugin and tries to use Cairn features (skills, MCP) without bootstrapping, the plugin enters **degraded mode**:

- MCP read tools work (read-only access to ground state)
- MCP write tools return `BOOTSTRAP_REQUIRED` envelope
- cairn-direction skill blocks: "bootstrap required before Cairn can drive task work for this clone"
- cairn-attention shows but can't resolve

Forces dev2 through the bootstrap before any Cairn feature engages.

### Adoption commits

Phase 13 (pre-commit hook install) becomes "git hooks + CI workflow + bootstrap docs". Files committed:

```
.cairn/git-hooks/pre-commit            — sensor runner
.cairn/git-hooks/commit-msg            — optional: validates DEC/TSK refs in commit msg
.cairn/JOIN.md                         — instructions for new contributors
.github/workflows/cairn-check.yml      — CI gate (or equivalent for non-GitHub)
package.json prepare script            — auto-bootstrap on install (Node projects)
```

### Pre-adoption commits

When adopting an existing project with prior history, the CI gate's `--diff origin/main..HEAD` only checks the PR's net change, not the entire prior history. Pre-existing violations don't block — they go to baseline (Phase 11 audit). Future commits are gated.

## §18 Resolved during draft (cross-references)

The following decisions were made during drafting and folded into the relevant sections — listed here for traceability:

| Topic | Resolution | Section |
|-------|------------|---------|
| Source-comment detection threshold | Block > 3 lines OR > 200 chars OR JSDoc with > 30 words of prose; deterministic (no LLM); 20 blocks/Haiku batch for classification | §6 Phase 9, §15 |
| Comment replacement | Mechanical string substitution, never LLM-rewritten | §15 |
| Pre-write safety | Skip dirty files (offer stash/skip/overwrite); backup originals to `.cairn/backups/source/<rel>.original` | §15 |
| Subagent output | Each subagent's output streams verbatim; reviewer produces final attestation summary | §8, §11 |
| Adoption tracking | `${CLAUDE_PLUGIN_DATA}/projects.json` keyed by abs-path; `decline-temp` re-prompts after 7 days; `decline-never` requires explicit `/cairn-init` to re-prompt | §11 (skills) |
| Existing rules merge | Adoption ingests; post-adoption regenerates `CLAUDE.md` + `AGENTS.md` from ground state with `<!-- cairn:keep-start -->` operator sections preserved | §6 Phase 10 |
| Reviewer last-detection | Stop hook scans `.cairn/tasks/active/<id>/` for missing `attestation.yaml`; spawns reviewer if any | §10 |
| `--no-verify` bypass detection | Pre-commit hook (paired with post-commit) appends attested SHAs to `.cairn/.attested-commits`; Stop hook diffs against HEAD's last 5; surfaces backfill prompt | §17 Layer 1 |
| Uninstall vs full uninstall | `cairn uninstall` light (stops enforcement, keeps state); `cairn uninstall --full` restores original comments from backups, deletes `.cairn/`, removes hooks + CI workflow | §16 |
| MCP project-root detection | cwd-based walker (look for `.cairn/` or `.git/`); no env var dependency | §9 |
| Subagent dispatch protocol | Skill emits structured ```dispatch``` fenced block; main Claude parses and issues Task calls | §11 |
| Claude binary requirement | **Hard requirement** — no degraded mode. Adoption preflight detects missing `claude`, bails with install instructions | §6 Phase 1 |
| Source-comment scan scope | **No cap** — every source file processed during adoption, accept the one-time Haiku spend per "fully processes once" mandate | §6 Phase 9 |
| `cairn-direction` skill triggering | Auto-invoke via fuzzy `description` matcher + slash command `/cairn-direction <prompt>` as escape hatch when auto-invoke misses | §11 |

## §19 Build history

The plugin pivot landed across ten steps. Per-step deliverables:

1. **Repo unification** — four workspace packages live under `packages/*` (`cairn`, `cairn-core`, `cairn-frontend-claudecode`, `cairn-lens`). The internal in-memory test adapter `cairn-frontend-stub` was deleted post-pivot.
2. **Tier-1 Haiku subprocess** — `claude --model haiku` subprocess + JSON-schema output replaces the pre-pivot local-classifier backend. (The earlier Tier-0 prompt-classifier and backend tightener modules were both purged in v0.2.1; routing + tightening are now main-Claude judgment via the `cairn-direction` skill. Haiku is the lowest active backend tier.)
3. **Flock + per-session state partition + invalidation events** — `cairn-core/src/lock.ts`, `.cairn/sessions/<id>/`, `.cairn/events/`. Every write tool wraps in flock; per-session marker + Stop-hook poll cursor.
4. **Plugin scaffold** — `cairn-frontend-claudecode/` manifest, `.mcp.json`, `hooks/hooks.json`, hook bin entrypoints under `cairn-core/dist/hooks/`.
5. **Skills + slash commands** — cairn-adopt, cairn-direction, cairn-attention; `/cairn-init`, `/cairn-direction`.
6. **Reviewer subagent + `cairn_resolve_attention` + Stop scan** — `agents/reviewer.md`, MCP tool for inline A/B/C resolution, Stop hook scans for tasks pending review.
7. **Heavy adoption pipeline** — Phase 9 source-comment ingestion, Phase 10 rules merge, Phase 12 strip-replace primitives.
8. **Multi-developer enforcement** — versioned git hooks, `cairn join` bootstrap, CI gate, plugin degraded mode, Stop-hook bypass detection.
9. **End-to-end smoke + visual init wiring** — adopted-fixture E2E smoke, daily-flow E2E smoke, Phase 9/10/13 wired into the init.ts visual pipeline.
10. **Pre-publish prep** — gitleaks scan, content audit, README rewrite, name + LICENSE.

The build is feature-complete at v0.1.0. Subsequent work tracks via the
attention queue + DEC drafts.

---

End of spec. All draft-time questions resolved; see §18 for traceability.
