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
5. **Enforces constraints** with the sensor sweep at two gates: the pre-commit git hook (canonical backstop, blocks on hard findings) + CI (`cairn sensor-run --diff … --strict`). The plugin Stop hook surfaces in-session signals (stalled tasks, attention, bypasses) but does not run the sweep.
6. **Captures decisions** the reviewer surfaces from the diff, auto-accepted into the ledger by default (verify-then-accept; §7.6) — review rides the PR diff, with dedup-fallback drafts surfaced inline next session.
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
│   ├── cairn-adopt/SKILL.md             — first-time adoption flow
│   ├── cairn-adopt-components/SKILL.md  — backfill the component store into an adopted repo
│   ├── cairn-direction/SKILL.md         — prompt → tier0 → tightener → dispatch
│   └── cairn-attention/SKILL.md         — surface pending DEC drafts + drift inline
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
| 9d–9f | **Component store** trio — `9d-comp-walk` lists un-headered files, `9e-comp-annotate` (skill-driven, operator-gated) dispatches `component-annotator` subagents to write `@cairn` headers, `9f-comp-emit` builds the index + drafts singleton §INVs + audit. No-ops on non-UI repos | "Annotating components…" → annotated / indexed / singleton / missing counts |
| 11 | Baseline sensor audit | Per-sensor status; finding counts |
| 12 | **Comment policy enforcement** (strip) | Per-module preview + A/B/C consent |
| 13 | Multi-dev enforcement install + summary | "Installed git hooks + CI gate" → summary |

After this single pass, Cairn IS the project maintainer. Source files are clean (only `// §INV-<hash>` and `// TODO(TSK-)` cites). All prior decisions are canonicalized. Existing rules are merged. Sensors are baselined. Inconsistencies are resolved or queued.

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
- **DEC ID allocation** atomic under the per-write lock. Two sessions calling `cairn_record_decision` get distinct DEC-<hash> values.
- **Invalidation events**: when a global write completes, Cairn writes `.cairn/events/<ts>-<event>.json`. Plugin instances poll the events directory at Stop hook (chokidar file watcher armed, debounced). If an event touches a DEC/§INV in the current session's in-scope set → surface inline:
  > A modified DEC-a3f7b2c (which you're using). `[a]` refresh in-scope `[b]` continue under old `[c]` abort

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

## §7.6 Decision auto-accept

Cairn runs inside an autonomous coding agent, so AI-proposed decisions
**auto-accept** straight into the ledger by default rather than queuing as
`_inbox/` drafts for per-item operator triage. `cairn_record_decision`
promotes a decision to `accepted` when **all** hold:

1. The caller did not pin a `target` (the normal AI path; an explicit
   `target: "inbox"` is the per-call escape hatch that forces a draft, and
   `target: "accepted"` forces direct accept).
2. **Verify-then-accept passes**: the decision's assertions are
   schema-valid (already enforced by the tool) and the title is **not a
   near-duplicate of an already-accepted decision** (deterministic
   title-Jaccard against the ledger at the `definite` threshold). A
   near-duplicate falls back to an `_inbox/` draft for human eyes instead
   of silently re-landing.

Auto-accepted decisions carry `auto_accepted: true` in their frontmatter
for provenance. **The human review checkpoint moves from the
`cairn-attention` triage queue to the committed-ground-state PR diff** —
the decision lands in `.cairn/ground/decisions/` and is reviewed in the
normal pull-request diff like any other committed file.

This is independent of **§17 multi-developer enforcement**, which gates
*sensor attestation* at commit/CI time, not decision approval. Auto-accept
does not weaken §17: sensors still run, CI still gates, and an
auto-accepted DEC whose assertions break a build surfaces at PR time.
(`target: "inbox"` remains the per-call way to force a specific decision
into the triage queue instead.)

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
   - On UI work: queries `cairn_components_in_scope` and reads the
     FULL in-scope inventory into the spec before building (USE >
     EXTEND > CREATE) — never rebuilds an existing component
   - Works in main repo (no mirror, no runtime checkout)
        │
        ▼
Reviewer subagent fires LAST
   - Reads diff, sensors output, attestation.yaml from each subagent
   - Records non-obvious choices as DECs — auto-accepted into the ledger
     by default (verify-then-accept; see §7.6), dedup-rejected ones land
     as _inbox/ drafts
   - Returns attestation summary
        │
        ▼
Stop hook (plugin) — fires when assistant turn ends
   - Run sensors on diff (staged + unstaged)
   - If findings → surface inline A/B/C
   - Poll invalidation events; if relevant → surface refresh prompt
   - If DEC drafts queued (dedup fallbacks / explicit-inbox) → surface
     "review N pending decisions? [a/b/c]"
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

Tools (32 current, see `MCP_SURFACE.md` for full schema):

- **Read — graph traversal**: `cairn_decision_get`, `cairn_canonical_for_topic`, `cairn_invariant_get`, `cairn_in_scope` (unified DEC+INV path-glob lookup; filter via `types: ["decision"|"invariant"]`).
- **Read — search + retrieval**: `cairn_search`.
- **Read — component store**: `cairn_components_in_scope` (full in-scope component inventory before UI work — the "full slice read"), `cairn_component_get`.
- **Read — historical (gated)**: `cairn_query_history`.
- **Read — resume layer**: `cairn_resume` (cold-resume payload for an active task after `/clear`).
- **Write — ground + tasks**: `cairn_record_decision`, `cairn_task_create`, `cairn_task_complete`, `cairn_task_reopen`, `cairn_task_journal_append`.
- **Write — attention queue**: `cairn_resolve_attention(item_id, choice)` (inline-A/B/C resolution endpoint — skill calls this after operator picks), `cairn_attention_dedup`.
- **Write — bootstrap recovery**: `cairn_bootstrap_retry`.
- **Write — init pipeline**: `cairn_init_resume`, `cairn_init_run`.
- **Mission system — supra-task layer**: `cairn_mission_start`, `cairn_mission_accept_draft`, `cairn_mission_get`, `cairn_mission_plan_phase`, `cairn_mission_advance`, `cairn_mission_resume`, `cairn_mission_resync`, `cairn_mission_resync_accept`, `cairn_mission_set_exit_gate`.

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
| Skill | `skills/cairn-adopt-components/SKILL.md` | Operator asks to adopt/backfill the component store on a repo that has `.cairn/` but no `components:` config (adopted before v0.18.0) | Runs the standalone component trio inline (detect config → batched `component-annotator` subagents → emit index + singleton §INVs + audit baseline); hands the baseline to `cairn-attention` |
| Skill | `skills/cairn-direction/SKILL.md` | Auto-invoked when operator's user message looks like a task ("build…", "add…", "fix…", "refactor…") and there's no active task | Runs tier0 → tightener → dispatch chunks via Task tool |
| Skill | `skills/cairn-attention/SKILL.md` | SessionStart context flagged `attention_count > 0` | Surfaces pending DEC drafts + drift + baseline findings as inline A/B/C; calls `cairn_resolve_attention` after each pick |
| Subagent | `agents/reviewer.md` | **Opt-in.** Spawned only when the operator explicitly asks for a diff review or DEC-drafting sweep | Reads diff + sensor outputs + attestation files; extracts non-obvious DECs; returns attestation summary |
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

The `cairn-direction` skill (steps 4-5) produces a structured **dispatch block** that main Claude reads and turns into Task-tool calls.

**Chunking decision.** The skill chooses chunks by file/module boundary — each chunk should touch a single top-level dir or service.

- **1 chunk** → skill omits the `dispatch` block and instructs main Claude with "Tightened spec at `.cairn/tasks/active/<task_id>/spec.tightened.md`. Implementing directly." No plan review.
- **≥2 chunks** → skill renders a 1-line plan review for the operator before dispatching:

  > Plan: 3 subagents — `[auth]` `[billing]` `[tests]`. `[a]` dispatch  `[b]` modify  `[c]` cancel
  > Tightened spec: `.cairn/tasks/active/<task_id>/spec.tightened.md`

  `[a]` → emit the dispatch block. `[b]` → loop chunking with operator feedback. `[c]` → archive the task, end the turn.

**Dispatch block format** (skill output ends with this exact shape):

````markdown
## Dispatch plan

Tightened spec: `.cairn/tasks/active/<task-id>/spec.tightened.md`

```dispatch
- subagent: general-purpose
  brief: |
    Read .cairn/tasks/active/<task-id>/spec.tightened.md.
    Implement the auth middleware portion (files: services/auth/*.ts).
    Cite §INV-a3f7b2c, §INV-c81d5e0 in any new code. If you leave any
    explicit follow-up in source (deferred edge case, missing piece
    that belongs to this task but is out of scope for this chunk),
    drop a `// TODO(TSK-<task_id>)` cite on that line.
    Return a 1-paragraph summary of what landed.
- subagent: general-purpose
  brief: |
    Read the same spec.
    Implement the billing portion (files: services/billing/*.ts).
    Cite §INV-5d6e7f8. Same TODO(TSK-) rule. Return summary.
```
````

Main Claude parses the `dispatch` block, spawns one Task call per entry (in parallel where possible), aggregates returned summaries, then calls `cairn_task_complete({outcome, summary})` with a consolidated 1-2 paragraph attestation summary — that summary IS the attestation (Phase 2 self-attest contract; no `attestation.yaml` on disk on the default path). The reviewer subagent is opt-in and runs only when the operator explicitly asks for a diff review or DEC-drafting sweep.

For 1-chunk tasks where main Claude implements inline, the same `// TODO(TSK-<task_id>)` rule applies: bare `TODO` doesn't resolve via the citation legend, only the cite form does.

### Operator-rejection capture

When the operator's prompt rejects prior work, the `cairn-direction` skill captures the pattern as a DEC BEFORE the local fix so the rule materializes into ground state (sensors + reviewer + SessionStart context all read DECs). The DEC auto-accepts by default (§7.6) — the rejection IS the operator's decision, so it lands in the ledger immediately rather than waiting in a triage queue. Trigger gate — ALL must hold:

1. Rejection signal in the current prompt (substring, case-insensitive): `bad,` / `bad.` / `is bad` / `was bad` (as a verdict — not embedded in `badge` etc.); `don't like` / `dislike` / `i hate`; `stop using` / `don't use` / `never use`; `avoid` (as a directive); `remove that` / `kill that` / `kill the`; `that's wrong` / `wrong approach`; sentence-leading `no, ` rejecting prior work.
2. The prior assistant turn produced visible code or a concrete pattern (file edit, diff, code snippet, MCP tool output). Skip when the rejection targets a question or proposal rather than shipped code.
3. The rejection points at an extractable pattern — a specific identifier, token sequence, or code shape that can be encoded as a regex. Skip vague "this whole thing is bad" rejections.

When all three hit:

1. Extract a concrete regex (e.g. `\bas\s+unknown\s+as\b`, `@ts-ignore`, `console\.log`), the scope globs the rule applies to (language-wide default like `**/*.ts` / `**/*.tsx`; narrow when the operator scoped it), and a one-line rationale (operator's reason or best inference).
2. Dedupe via `cairn_search({query: "<regex/token>", kind: "decision"})`. When an accepted DEC already targets the same pattern, surface `Pattern already in DEC-<id>; not re-drafting.` and continue.
3. Call `cairn_record_decision` (omit `target` — it auto-accepts by default per §7.6; the built-in dedup gate routes a near-duplicate to an `_inbox/` draft instead):

   ```jsonc
   cairn_record_decision({
     title: "Reject `<rejected pattern>`",
     summary: "<one-line rationale>",
     scope_globs: [<extracted globs>],
     body_markdown: "<markdown body — Decision / Why / Enforcement>",
     assertions: [{
       id: "a1",
       kind: "text_must_not_match",
       pattern: "<extracted regex>",
       in_globs: [<extracted globs>],
     }],
   })
   ```

4. Surface ONE line — using the tool's `auto_accepted` result: when accepted, ``Captured rejection → `DEC-<id>` accepted into ground state.``; on dedup fallback, ``Captured rejection → draft `DEC-<id>` queued for review (`/cairn-attention`).``
5. Continue normal direction flow (pivot detection, mission scope, Step 1 onward). The operator's current-turn fix still needs handling — the capture is additive, not a replacement.

When the rejection is too vague to encode within ~30 seconds of reasoning, skip the draft and apply the local fix directly. A hand-wavy assertion is worse than no DEC.

### Pivot detection (active-task path)

When `.cairn/tasks/active/<id>/` exists and the operator's new prompt arrives, the skill compares the prompt to the active task's title + goal:

- **Cold-resume continuation.** Prompt matches a continuation token (`continue`, `go`, `next`, `keep going`, `more`, `proceed`) AND the journal carries entries from a different `session_id` → skip the pivot prompt and run the auto-resume primer (`cairn_resume`, read `files_touched` cap-8 most-recent-first parallel, read `spec.tightened.md`, pick up from `next_step`).
- **Same subject** (follow-up on the same files / noun set / explicit reference like "now also handle the X case in that fix") → no pivot, no `cairn_task_create`. Continue work directly.
- **Diverging subject** (different feature area, different file globs, different noun set) → `AskUserQuestion`:

  > Active task `TSK-<id>` is `<title>` (`<phase>`). Your new ask looks unrelated. Pick:
  >
  > - `[a]` complete TSK-<id> first
  > - `[b]` pivot — abort TSK-<id>, start fresh on the new ask
  > - `[c]` keep TSK-<id> active, fold the new ask as a sub-task

  `[a]` → end turn with one-line note. `[b]` → `cairn_task_complete({task_id, outcome: "aborted", summary: "pivoted to: <new ask>"})`, then Step 1. `[c]` → `Edit` the spec's `## Goal` section to add a bullet, end turn.

### Mission scope detection (no active mission)

When `cairn_mission_get({})` returns `active: false`, the skill **always runs a complexity check** — proposing a mission is not opt-in, and the operator never has to ask for one. Cairn surfaces the mission/task choice the moment the work outgrows a single task.

**Strong triggers — any ONE fires the prompt:**

- Enumerated phases / steps (`1. … 2. …`, `first … then …`, a numbered deliverable list).
- Scope phrasing — `build the whole / entire X`, `redesign Y end-to-end`, `rewrite Z`, `from scratch`.
- The prompt points at a spec/planning artifact — a `.md` path, a pasted PRD, or >300 words with 2+ H2/H3 sections.

**Weak signals — 2+ together fire the prompt:** 3+ distinct task verbs; 3+ feature nouns from different areas; cross-cutting work spanning 3+ modules; explicit multi-sitting framing.

When nothing fires, the skill proceeds as a single task — but if it is about to create a task whose `goal` spans 3+ modules or whose acceptance has 4+ independent bullets, it re-runs this check first. The bar is deliberately low: a missed mission costs the operator a sprawling untracked task; a false-positive costs one `AskUserQuestion` they answer `[b]` to.

Trigger → `AskUserQuestion`: `[a]` mission (recommended for the listed scope), `[b]` single task.

On `[a]`: pick a slug (first 3-4 words of the prompt's first sentence, kebab, ≤30 chars). `mkdir -p .cairn/missions/_drafts/` then `Write` the prompt verbatim to `.cairn/missions/_drafts/<slug>.md` with an H1 ≤60 chars prepended. Call `cairn_mission_start({spec_path, exit_gate: "prompt"})`. The response carries a draft envelope (proposed_title, spec_path, exit_gate, phases, truncated, llm_used). Surface the phases via a second `AskUserQuestion` so the operator confirms before commit (`[a]` accept, `[b]` edit first, `[c]` cancel). On accept: `cairn_mission_accept_draft({title, spec_path, exit_gate, phases})` with the values from the start response. Mission goes live with the cursor on phase-1.

On `[b]`: skip the mission, proceed as a single task. On accept-edit `[b]`: end the turn pointing at the draft path; the operator edits inline and re-asks.

### Mission anchoring (active mission)

When `cairn_mission_get` returns `active: true`, `cairn_task_create` auto-stamps `mission_id` + `phase_id` from the cursor when both fields are omitted. The default is to omit — let cursor pickup win.

**Off-mission detection.** Read the cursor phase's `title` + `exit_criteria` from the `cairn_mission_get` response. If the operator's prompt clearly diverges (different file globs, different feature area, no overlap with exit_criteria), surface `AskUserQuestion`: `[a]` side-task (`mission_id: ""`, no phase anchor), `[b]` fold into current phase (omit mission fields), `[c]` advance to a different phase first (list pending phases via a follow-up question, operator picks one, then `cairn_mission_advance({phase_id: <current>, choice: "force"})` and re-run anchoring).

### Per-phase brief — just-in-time phase tightening

The roadmap draft is deliberately thin: each phase carries only a `title` + `exit_criteria`. The detail — the load-bearing decisions, the constraints tasks must honour, the phase's verifiable acceptance bar — is tightened **just-in-time when the cursor lands on the phase**, not upfront. This mirrors the GSD `discuss-phase → plan-phase` pattern: plan the phase you are about to execute, with current ground state in hand, rather than guessing the whole mission's detail at draft time.

`cairn_mission_get` exposes `cursor.active_phase_brief_status` (`null` = brief-pending, `drafted`, `accepted`) and `cursor.active_phase_brief` (the committed brief, if written). The direction skill's **Step 2.55** gate reads this before creating any phase-anchored task:

- **`accepted`** → fold the brief's `constraints` + `acceptance` + cites into the `cairn_task_create` call; skip tightening.
- **`null` (brief-pending)** → tighten the phase now:
  1. Gather phase-scoped ground state (`cairn_canonical_for_topic` + `cairn_in_scope` for the phase topic; read `exit_criteria` + the phase's `spec.md` slice).
  2. Find load-bearing forks the ground state does **not** already resolve (same §14 bar as task tightening).
  3. **Smart gate** — no unresolved forks → `cairn_mission_plan_phase({ status: "accepted", decisions: [] })` silently; the phase is briefed with zero operator friction. Unresolved forks → `AskUserQuestion` (cite DEC / §INV per option, loop rounds), then `cairn_mission_plan_phase({ decisions, constraints, acceptance, cite_decisions, cite_invariants })`.

`cairn_mission_plan_phase` writes a committed `.cairn/ground/missions/<id>/briefs/<phase-id>.md` (multi-dev visible, the phase analog of `roadmap.md`) and stamps `phase_progress[phase].brief_status`. Tasks created in the phase inherit the brief as their spine — that is the channel through which per-phase tightening reaches the work.

**Autonomy.** Under `exit_gate: "auto"` (or an active autonomy phrase), Step 2.55 never prompts: the model self-resolves the forks from ground state + best judgement and calls `cairn_mission_plan_phase({ …, autonomous: true })`. The brief records the chosen answers so the operator can audit them after the fact. Phase tightening is never skipped — only its prompting is suppressed.

**Resume.** `cairn_mission_resume` primes the cursor phase's brief (decisions / constraints / acceptance) into the post-`/clear` frame, and flags `brief: pending` when the phase still needs Step 2.55. The brief survives `/clear` because it is committed state, not chat context.

### Autonomous mission continuation

Operators often "vibe-code" — they type `continue` or `go` and expect the next chunk of work to just happen. The autonomy-config friction (questions about `exit_gate`, questions about which PR) defeats the point. Trigger gate — ALL must hold:

1. `cairn_mission_get` returned `active: true`.
2. No active task in `.cairn/tasks/active/`.
3. Operator's prompt matches a continuation intent: bare token (case-insensitive, ≤30 chars) — `continue`, `go`, `next`, `more`, `do it`, `run it`, `keep going`, `ship it`, `proceed`, `execute`, `start`, `begin`; OR an autonomy phrase (substring, any length) — `execute autonomously`, `run autonomously`, `just keep going`, `don't pause`, `don't stop`, `no questions`, `don't ask`, `ship the whole`, `until context`, `until ctx`, `autonomously`. Do NOT trigger on bare `yes` / `ok` / `sure` — those typically answer prior `AskUserQuestion` prompts.

When all three hit, the skill acts silently:

1. **Flip `exit_gate` if needed.** If `cairn_mission_get` returned `exit_gate: "prompt"` AND `.cairn/missions/<mission_id>/.autonomy-prompted` doesn't exist: `cairn_mission_set_exit_gate({exit_gate: "auto"})`, write the marker with the current ISO timestamp, surface ONE line: `Mission set to auto-advance — phase boundaries won't pause.` The marker prevents re-prompting; operators who change their mind can `rm` it.
2. **Auto-pick the next pending PR.** Extract PR slugs from `cursor.active_phase_exit_criteria` via regex `\d+\.\d+-[A-Z]+\d+` (e.g. `3.5-BH1`). Preserve operator order. A PR is considered graduated when any task in `phase_progress[<active_phase>].task_ids` has a `done/<task_id>/` directory whose `status.yaml` `title` / `id` references the PR's bare token (case-insensitive). Pick the first slug not yet graduated. Free-form prose with no PR shape → infer the next deliverable from the first sentence-clause naming a concrete output.
3. **Render one-line status and jump to Step 3.** Surface: `Continuing mission <mission_id> → starting <pr-or-deliverable>.` Skip Steps 1, 2, 2.5. Use the picked slug as `slug`, the PR's role from `exit_criteria` as `title`, the phase goal as `goal`. `cairn_task_create` auto-stamps `mission_id` + `phase_id`.

After dispatch + completion, `cairn_task_complete` returns a `next_action_hint` block — the model self-chains via that hint (continue with the next pending PR, start the auto-advanced next phase, or end on mission close) without re-entering the skill. A single `continue` covers the entire remaining mission modulo context limits.

Yield to the operator ONLY when:

- The phase's `exit_criteria` has no PR slugs AND the prose is too ambiguous to infer a concrete deliverable. Surface one `AskUserQuestion` asking the operator to name what's next.
- A spawned subagent reports a failure that needs operator review.
- Context approaches the configured threshold (the Stop hook's ctx-threshold surface owns this independently).

Otherwise, keep going. The vibe coder asked for autonomy.

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
| "You said 'add billing'. Per DEC-d4e6a92 Stripe is the only payment processor. Adding a new product to the existing integration `@/services/stripe`, or replacing it with something else?" | References existing constraint; identifies fork; asks about something that materially changes the spec |
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

- `// §INV-<hash>` — invariant reference
- `// TODO(TSK-<id>)` — linked task

Banned: DEC-id comments, essay JSDoc, multi-paragraph rationale, restated requirements.

### Three stages, with strict LLM/deterministic split

| Stage | LLM? | What happens |
|-------|------|--------------|
| **Detection** | **No** — deterministic | Walker finds essay-style comment blocks via heuristic: block comment > 3 lines OR > 200 chars OR JSDoc with > 30 words of prose. Per-language tweaks (Python `"""…"""`, Rust `///`, Go `//`, etc.) |
| **Extraction** | **Yes** — Haiku batch | 20 detected blocks per Haiku call → JSON: `{ block_id, type: "rationale" | "constraint" | "citation" | "license" | "other", suggested_dec_draft?, suggested_invariant?, suggested_canonical_topic? }`. License headers + "other" left in source untouched |
| **Replacement** | **No** — deterministic | Mechanical string substitution: strip the original block, insert `// §INV-<hash>` (if §INV exists or was just proposed) or `// TODO(TSK-<id>)` (if linked to active task). Never LLM-rewritten |

### Pre-write safety checks

Before any source file is modified during Phase 10:

1. **Uncommitted-changes check** — `git status --porcelain` on the file. If dirty:
   > `services/auth.ts` has uncommitted changes. Replacing comments would mix into your work-in-progress. `[a]` stash and process `[b]` skip this file `[c]` overwrite (lose uncommitted changes — destructive)
2. **Backup** — copy `services/auth.ts` → `.cairn/backups/source/services/auth.ts.original` (preserves directory structure). One backup per file, single snapshot — a transient safety net the operator can restore by hand during the post-adoption repair window. Migration `0003` prunes `.cairn/backups/` once adoption settles; it is not read by tooling and is NOT the uninstall mechanism (see §16).
3. **Diff preview** — generate the proposed diff and show in the per-module batch consent prompt before any write.

### Consent flow

**Per-module batch (default):**

> Module `core/auth` has 23 essay-style comment blocks. Extracted: 8 DEC drafts, 3 §INV candidate invariants. Diff preview: [collapsible].
> `[a]` strip all (review extractions in `_inbox/`) `[b]` review per-file (escalation) `[c]` skip module

**Per-file escalation when operator picks `[b]`:**

> `services/auth.ts:42-78` — 24-line JSDoc on JWT signing rationale. Extracted as DEC-draft-0042 + §INV-a3f7b2c invariant proposal. Replacement: `// §INV-a3f7b2c`. Diff: [collapsible].
> `[a]` apply `[b]` keep as-is `[c]` modify (open in editor)

If the file has uncommitted changes the per-file prompt also shows the dirty-file warning.

### Post-adoption ongoing capture

Reviewer subagent extracts DEC drafts from new essay-style comments the operator writes during normal work, surfacing in next session's attention pass. Same three-stage split: deterministic detection, LLM extract, deterministic replace (only when operator approves). Same backup convention.

## §16 Uninstall

`cairn uninstall` removes Cairn from a repo — the inverse of adoption. It is
destructive, so it **previews by default** and only applies under `--yes`.
Steps run in dependency order:

| Step | What it does |
|------|--------------|
| expand cites | Replaces each `// §DEC-/§INV-` citation with the entity's body inline, as a plain comment in the file's own comment style — so removing `.cairn/` leaves the source self-documenting with no dangling refs. The cited-file set is found by **scanning the working tree** (not the scope-index, which can be stale). `--keep-cites` skips this and the `§` tokens then dangle. |
| unwire import | Removes the `@.claude/rules/cairn.md` import block from `CLAUDE.md` / `AGENTS.md`. Operator content is preserved; the memory file itself is kept. |
| remove rule | Deletes `.claude/rules/cairn.md` and prunes `.claude/rules/` (and `.claude/`) if they empty out. |
| unset hooks | Unsets `git config core.hooksPath` — ONLY when it is Cairn's own value (`.cairn/git-hooks`). A foreign husky/lefthook path is warned and left intact. |
| remove state | Deletes `.cairn/`. |

Cite expansion happens FIRST, while `.cairn/ground/` still exists to resolve
the bodies — it does not use the transient `.cairn/backups/` snapshots (§15),
which migration `0003` prunes early and which no tooling reads.

The machine-level Claude Code plugin is **user-scoped**, not repo-scoped, so
uninstall can't remove it; it prints the `/plugin uninstall cairn` reminder
instead. Re-adoption is a fresh `cairn init`.

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

The git hooks + CI workflow + bootstrap docs are **seeded from
`templates/` by Phase 4 (seed)** and **activated per-clone by `cairn
join`** (`git config core.hooksPath`). Phase 13 (multi-dev) layers the
host hints + the `.claude/rules` import on top — it does not install the
hooks itself. Files committed:

```
.cairn/git-hooks/pre-commit            — sensor runner (seed; activated by join)
.cairn/git-hooks/commit-msg            — clean pass (no commit-message sensors)
.cairn/JOIN.md                         — instructions for new contributors
.github/workflows/cairn-check.yml      — CI gate (cairn doctor + sensor sweep)
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
| Uninstall | `cairn uninstall` (preview; `--yes` to apply) expands DEC/INV cites to inline comments, unwires the rule import, removes `.claude/rules/cairn.md`, unsets Cairn's `core.hooksPath`, deletes `.cairn/`. Single mode — no backup-restore | §16 |
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
