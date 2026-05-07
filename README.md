<div align="center">

# Cairn

**Persistent ground truth for Claude Code.**
Stop AI agents from drifting.

[![npm version](https://img.shields.io/npm/v/@isaacriehm/cairn?style=flat-square&logo=npm&color=CB3837)](https://www.npmjs.com/package/@isaacriehm/cairn)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-D97706?style=flat-square)](https://claude.com/claude-code)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square)](https://nodejs.org)

```bash
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
/reload-plugins
```

[The Problem](#the-problem) · [What You Get](#what-you-get) · [Quick Start](#quick-start) · [Glossary](#glossary) · [How It Works](#how-it-works) · [Features](#features) · [Multi-Dev](#multi-developer-enforcement) · [Docs](#documentation)

</div>

---

A *cairn* is a stack of stones marking a trail. This project stacks the
**decisions, invariants, and canonical references** that define your
codebase into a single queryable ground state — so every Claude Code
session starts with the same map.

## The Problem

Monday: you tell Claude Code "auth tokens expire after 24 hours." It
ships. Works.

Friday, new session, new prompt. The agent reads `auth/tokens.ts`, sees
no comment about expiry, and "improves" the code to a 7-day refresh.
You catch it in review. Or you don't.

The model isn't bad. The model has **no memory of what you decided**.

A bigger context window doesn't fix this — it just delays it. What
fixes it is a structured record on disk that every session reads from
and writes to. Cairn is that record, plus the runtime that keeps it
load-bearing.

## What You Get

Three persistent stores, version-controlled in `.cairn/`:

🪨 **Decisions (`DEC-NNNN`)** — every architectural choice gets a
markdown file with rationale, scope, and a supersedes chain. Once
accepted, canonical until explicitly replaced. The agent reads the
in-scope decisions before touching the affected code.

```
DEC-0042  Auth tokens expire after 24 hours
  Scope:       src/auth/**
  Rationale:   PCI compliance — short-lived bearer tokens
  Supersedes:  DEC-0017 (7-day refresh, deprecated 2026-02-14)
```

🧭 **Invariants (`§INV-NNNN`)** — domain rules whose violation is a
bug, not a style preference. *"All API responses must include a
`request-id` header."* Sensors enforce them on every diff at
pre-commit and again at CI.

🗺️ **Canonical map** — `topic → file` index. Ask
`cairn_canonical_for_topic("rate limiting")` and get the actual file
paths instead of the agent grepping vaguely or fabricating them.

Plus four runtime layers that keep those stores live: an **MCP
server** (39 typed tools), a **Claude Code plugin** (skills + hooks +
reviewer agent), **sensors** (4 layers of automated diff checks), and
a **CLI** for bootstrap and debug.

## Quick Start

Inside Claude Code, in any project:

```bash
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
/reload-plugins
```

(First registers the GitHub repo as a marketplace; second installs the
plugin; third loads it. The plugin ships a self-contained bundle —
hooks, MCP server, and CLI all run from `dist/cli.mjs` inside the
plugin cache. No `npx`, no `npm install -g`, no PATH dependency.)

Open Claude Code in any project. The plugin auto-detects on session
start and offers `[a] adopt now`. Pick `[a]` once. The pipeline streams
inline so you watch what's happening — typically 2-15 minutes
depending on repo size.

When it finishes, your next session starts with the full ground state
preloaded.

If you want `cairn` directly on your shell PATH (for `cairn doctor`,
`cairn attention`, `cairn trace`, etc.):

```bash
npm install -g @isaacriehm/cairn
```

…but the plugin doesn't require it. Outside Claude Code, you can adopt
via CLI instead:

```bash
cairn init
```

## Glossary

Read this once and the rest of the doc reads cleanly.

| Term                | Means                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| **DEC**             | Decision record — one architectural choice with rationale + scope + supersedes chain.                  |
| **§INV**            | Invariant — a domain rule the codebase must obey. Violations are bugs.                                 |
| **Scope**           | The file glob a DEC or §INV applies to (`src/auth/**`, `packages/billing/**`).                         |
| **Canonical map**   | `topic → file` index. The single source of truth for *"where does X live?"*                            |
| **Sensor**          | A mechanical check on a diff: stub patterns, decision violations, structural holes, attestation match. |
| **Attestation**     | A reviewer subagent's signed-off summary of what changed and why. Cross-checked by sensors.            |
| **Drift**           | When code or docs disagree with the ground state in `.cairn/`.                                         |
| **Bypass**          | A commit that skipped Cairn's hooks (`--no-verify`, broken hook path). Detected and surfaced.          |
| **Attention queue** | The pile of DEC drafts, baseline findings, drift events, and conflicts waiting for operator review.    |
| **Tightener**       | The Sonnet-driven step that turns a vague prompt into a structured spec before dispatching subagents.  |

## How It Works

Two flows: **adoption** runs once when you onboard a repo. **Daily
flow** runs on every prompt thereafter.

### Adoption (one time)

A single visual pass with nine phases. The plugin streams output
inline so nothing is opaque.

| Phase                | What happens                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1. Detect            | Probe environment + framework signals.                                                                                  |
| 2. Walk              | File manifest, extension stats, language detection.                                                                     |
| 3. Map               | Sonnet domain mapper proposes module boundaries + `scope-index.yaml` globs.                                             |
| 3b. Seed             | Write `.cairn/` skeleton, `config.yaml`, grandfather pre-adoption commits into `.attested-commits`.                     |
| 4. Pilot             | Operator picks a seed module from the mapper's top-3 candidates (one A/B/C question).                                   |
| 5. Brand             | Auto-fill brand / voice / product DEC drafts from the mapper's domain summary (one A/B/C).                              |
| 5b. Topic index      | Content-fingerprint pre-pass — dedupes facts that appear across docs, source, and rules before drafting DECs.           |
| 6, 7b, 7c (parallel) | **Docs ingest** + **Source comments ingest** + **Rules merge** (`CLAUDE.md` / `AGENTS.md`) — all Haiku-batched. Drafts → `_inbox/`. |
| 8. Baseline          | First sensor sweep against a synthetic full-tree diff. Findings written to `.cairn/baseline/`.                           |
| 10. Strip            | Per-module strip-replace consent — operator chooses keep / strip / skip for each flagged module.                         |
| 12. Multi-dev        | Detects package manager, installs git hooks, emits `JOIN.md` for new contributors.                                       |

After the pipeline finishes, the **`cairn-attention` skill** drains
the resulting draft queue. High-confidence drafts auto-bulk-accept;
the rest you triage interactively (or in a browser GUI when the queue
exceeds 15 items).

### Daily flow

```
You type a prompt
        │
        ▼
┌────────────────────────────────────────────────┐
│  Plugin auto-invokes the cairn-direction skill │
│   1. Skill loads in-scope DECs, §INVs,         │
│      and canonical-map entries via MCP         │
│   2. Main Claude classifies prompt readiness   │
│   3. If unclear → inline A/B/C questions       │
│   4. If ready → tightens spec inline, writes   │
│      .cairn/tasks/active/<id>/spec.tightened.md│
│   5. Spec dispatched to subagents              │
└────────────────┬───────────────────────────────┘
                 ▼
   Subagents work in your repo with MCP access:
     cairn_decisions_in_scope, cairn_invariant_get,
     cairn_canonical_for_topic, cairn_search, …
                 │
                 ▼
   Reviewer subagent attests the diff,
   extracts non-obvious decisions as DEC drafts
                 │
                 ▼
   Stop hook surfaces inline:
     "Review DEC-0099 draft? [a] accept [b] reject [c] edit"
                 │
                 ▼
   You commit → pre-commit hook runs sensors
              → CI gate verifies again on PR
              → drift caught before merge
```

The key bit: **the agent never starts cold.** Every prompt enters
with the relevant decisions, invariants, and canonical references
already loaded into the spec.

## Features

### Memory + ground state

- **Persistent decisions / invariants / canonical map** in
  version-controlled `.cairn/`.
- **Supersedes chains** — old decisions stay readable but flagged
  superseded; the chain is queryable via `cairn_supersedes_chain`.
- **Scope-aware preload** — the SessionStart hook injects only the
  DECs / §INVs that apply to files you've recently touched, instead
  of dumping the whole ledger into context.

### Adoption

- **Single visual pass** — operator watches the pipeline stream
  inline. No opaque background job.
- **Haiku-batched classification** — docs, source comments, and
  rules are ingested in parallel for speed.
- **Conflict detection** — when two sources disagree, surfaces a
  side-by-side resolution prompt instead of silently picking one.
- **Topic-index dedup** — content fingerprints prevent the same fact
  landing as three separate DEC drafts.

### Daily flow

- **`cairn-direction` skill** — auto-tightens vague prompts (*"fix
  the bug"*) into structured specs before dispatch. Loads the
  in-scope DECs, §INVs, and canonical-map entries automatically.
- **`cairn-attention` skill** — drains the queue of DEC drafts and
  sensor findings. Auto-bulk-accepts high-confidence drafts; spawns
  a local browser triage GUI when the queue exceeds 15 items.
- **Reviewer subagent** — every multi-chunk task ends with the
  reviewer attesting the diff and extracting non-obvious decisions
  into DEC drafts.
- **Status-line badge** — `⬡ cairn` in the Claude Code status row
  shows pending attention count, bypass warnings, GC state, and the
  active task title. Color-codes by absolute token usage.
- **Session trace log** — `cairn trace` pretty-prints unified
  per-session events. `--tail`, `--errors-only`, `--session`,
  `--json` flags supported.

### Sensors (four layers)

| Layer          | What it checks                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| **Layer A**    | Regex stub-pattern catalog (incomplete impls) + live SoT alignment via PostToolUse Write/Edit dedupe.         |
| **Layer B**    | Attestation cross-check — does the reviewer's claim match the actual diff?                                    |
| **Layer D**    | Decision-assertion enforcement — was the in-scope DEC honored?                                                |
| **Structural** | Route handlers non-empty, DTOs no fake fields, etc.                                                           |

Run at pre-commit, again at CI. Findings flow into the attention
queue. Drift events log to `.cairn/staleness/log.jsonl` and surface
on the next GC sweep.

### Tooling surfaces

- **MCP server** — 39 typed tools across read, write, history,
  attention, init, and search. Used by the plugin and any other MCP
  client.
- **CLI** — `cairn init / join / mcp / gc / scope / doctor / fix /
  attention / align / baseline / hook / sensor-run / tag / trace /
  status-line`.
- **Claude Code plugin** — manifest + 5 hooks (SessionStart, Stop,
  UserPromptSubmit, PostToolUse(Read), PostToolUse(Write|Edit)) + 3
  skills + 1 reviewer agent + 3 commands.
- **Cairn Lens** — VS Code / Cursor extension. Hover, gutter icons,
  code lens, optional DEC Explorer sidebar. Resolves `§INV-NNNN`,
  `§DEC-NNNN`, `TODO(TSK-…)` inline. Read-only — same ground state,
  no separate index.
- **Browser triage GUI** — local HTTP server spawned when the
  attention queue is large; avoids per-draft MCP round-trips.

## Editor Extension — Cairn Lens

Hover, ghost text, gutter icons, code lens — all resolved live from
`.cairn/ground/` ledgers. Read-only.

| Status      | Meaning                       |
| ----------- | ----------------------------- |
| `●` (green) | Active invariant              |
| `◐` (amber) | Superseded — see chain        |
| `○` (red)   | Orphan — not in ledger        |

Install the latest `.vsix` from
[releases](https://github.com/isaacriehm/cairn/releases) →
`Cmd/Ctrl+Shift+P` → `Extensions: Install from VSIX…`. Full setup in
[`packages/cairn-lens/README.md`](packages/cairn-lens/README.md).

## Multi-Developer Enforcement

Once a project is Cairn-adopted, every developer runs Cairn — locally
and at PR time. **Defense in depth:**

| Layer                         | What                                                          | Catches                                                     |
| ----------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| **1. Versioned git hooks**    | `.cairn/git-hooks/{pre,post,commit-msg}-commit`               | Local commits violating ground state.                       |
| **2. `cairn join` bootstrap** | CLI + `package.json prepare` script                           | Clones that haven't activated `core.hooksPath`.             |
| **3. CI gate**                | `.github/workflows/cairn-check.yml`                           | `--no-verify` slipping through. **Non-bypassable.**         |
| **4. Plugin degraded mode**   | SessionStart banner + MCP guard                               | Write tools refuse with `BOOTSTRAP_REQUIRED` until joined.  |

Plus **Stop-hook bypass detection** — flags any HEAD commits not in
`.cairn/.attested-commits` and surfaces `[a] backfill / [b] accept
(record DEC) / [c] defer`.

## Disk Layout

After `cairn init`:

```
.cairn/
├── config.yaml                  slug, version, project_globs
├── config/                      workflow.md, sensors.yaml, stub-patterns.yaml
├── ground/
│   ├── decisions/               DEC-NNNN.md per choice + _inbox/<id>.draft.md
│   ├── invariants/              INV-NNNN.md per §V rule
│   ├── canonical-map/           topic → file index
│   ├── brand/                   overview.md, voice.md
│   ├── product/                 positioning.md, personas.yaml
│   ├── conflicts/               <a-id>__<b-id>.md (DEC↔INV contradictions)
│   ├── alignment-pending/       ambiguous SoT-align cases queued for review
│   └── scope-index.yaml         file → DEC/§V resolution
├── baseline/                    first-sweep audit YAMLs
├── tasks/active/<id>/           spec.tightened.md, status.yaml, attestation.yaml
├── sessions/<session-id>/       per-session status + events
├── staleness/                   drift event log + deferred Layer-A queues
├── git-hooks/                   pre-commit, post-commit, commit-msg
├── runs/terminal/               one-shot CLI run logs
├── backups/source/              .original snapshots (rules-merge can revert)
├── .attested-commits            commit log used by bypass detection
└── JOIN.md                      new-contributor bootstrap doc
```

Full contract: [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md).

## Packages

```
packages/
├── cairn/                       umbrella + CLI bin (`cairn …`)
├── cairn-core/                  state, MCP server, sensors, hooks, init pipeline
├── cairn-frontend-claudecode/   Claude Code plugin (manifest, hooks, skills, agents, commands)
└── cairn-lens/                  VS Code / Cursor extension (.vsix)
```

## Documentation

| Doc                                                          | What                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| [System Overview](docs/SYSTEM_OVERVIEW.md)                   | End-to-end surface map + Mermaid diagram of all flows.        |
| [Architecture](docs/ARCHITECTURE.md)                         | Locked layered model, four-package boundary.                  |
| [Plugin Architecture](docs/PLUGIN_ARCHITECTURE.md)           | Adoption phases, hooks, multi-dev enforcement, question bar.  |
| [MCP Surface](docs/MCP_SURFACE.md)                           | Tool-by-tool reference.                                       |
| [Filesystem Layout](docs/FILESYSTEM_LAYOUT.md)               | `.cairn/` directory contract.                                 |

## Development

```bash
git clone https://github.com/isaacriehm/cairn
cd cairn
pnpm install
pnpm build
pnpm smokes        # 21-smoke gate. all green on a clean tree.
```

Other root scripts: `pnpm typecheck`, `pnpm clean`, `pnpm smokes:all`
(every declared smoke), `pnpm smoke:llm-prompt-eval` (opt-in
real-Haiku regression — burns quota). See
[`CLAUDE.md`](CLAUDE.md#common-commands) for the full table.

## Troubleshooting

### Skill listing budget on Sonnet (and other lower-context models)

Claude Code reserves **1% of the model's context window** for the
skill listing by default. On Opus (1M ctx) that's ~10 000 chars —
plenty of room. On Sonnet (200k ctx) it's ~2 000 chars, which is
tight once you add a few user-level plugins (design skills, image
generators, etc.). The cairn family ships ~3 skills + 3 commands; if
your listing is over budget, Claude Code drops the lowest-priority
descriptions — `cairn-direction` is a frequent victim, which means
the auto-invoke trigger gate never sees the prompt.

Diagnose with `/doctor`. If it reports `N descriptions dropped`, raise
the budget in `~/.claude/settings.json`:

```jsonc
{
  "skillListingBudgetFraction": 0.03  // 3% — fits cairn + ~30 user skills on Sonnet
}
```

Restart Claude Code. `/doctor` should now show `0 dropped`. If you
prefer to keep the 1% budget, disable user-level skills you don't use
(the `/skills` UI toggles each one), or add `skillOverrides` entries
in settings.json to set them to `"user-invocable-only"` (hidden from
the auto-invoke listing, still reachable via `/<name>`).

## Status

Pre-1.0. The Claude Code plugin is the daily-driven surface; the CLI
is the bootstrap and debug entrypoint. Issues + PRs welcome.

## License

[MIT](LICENSE) © Isaac Riehm

---

<div align="center">
<sub>Built with Claude Code. The plugin architecture takes cues from OpenAI's "harness lesson" on agent state — Cairn extends those ideas with explicit decisions, invariants, sensors, and a multi-developer enforcement layer for solo-or-small-team product engineering.</sub>
</div>
