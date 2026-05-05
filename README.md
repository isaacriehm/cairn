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

[Quick Start](#quick-start) · [Why](#why) · [How It Works](#how-it-works) · [Editor Extension](#editor-extension--cairn-lens) · [Multi-Dev](#multi-developer-enforcement) · [Docs](#documentation)

</div>

---

A *cairn* is a stack of stones marking a trail. This project stacks the
**decisions, invariants, and canonical references** that define your
codebase into a single queryable ground state — so every Claude Code
session starts with the same map.

No more re-explaining the architecture. No more the agent picking the
opposite of what you decided last week. No more "wait, where does X
live?"

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
start and offers `[a] adopt now`. Pick `[a]` once. Done.

If you want `cairn` directly on your shell PATH (for `cairn doctor`,
`cairn attention`, etc.):

```bash
npm install -g @isaacriehm/cairn
```

…but the plugin doesn't require it.

Adoption is a single visual pass — submodule init, repo walk, mapper,
brand setup, doc ingestion, source-comment ingestion, rules merge,
sensor sweep, multi-dev install. The plugin streams the output inline so
you see what's happening. After it finishes, agents in your next session
start with full ground state.

Outside Claude Code? Same thing via CLI:

```bash
npm install -g @isaacriehm/cairn
cairn init
```

## Why

I'm a solo developer. I let Claude Code drive most of my coding. The
problem isn't that the model is bad — the problem is that **every new
session starts with no memory of what I decided yesterday**. The agent
picks an interpretation. Sometimes it's the one I wanted. Sometimes it
re-debates a decision I already made and silently goes the wrong way.

The fix isn't a bigger context window. It's a **structured, queryable
ground state on disk** that every session reads from + writes to. Cairn
is that.

Three pillars:

- 🪨 **Decisions** stack up over time, each with a rationale, scope, and
  supersedes chain. Once accepted, they're canonical until explicitly
  superseded — never silently re-litigated.
- 🧭 **Invariants** are domain rules whose violation is a bug, not a
  style preference. Sensors enforce them on every diff.
- 🗺️ **Canonical map** answers "where does X live?" in one MCP call —
  no fuzzy grep, no fabricated paths.

## How It Works

```
You type a prompt
        │
        ▼
┌───────────────────────────────────────────────┐
│  Plugin auto-invokes cairn-direction skill    │
│   1. Tier-0 classifier (Haiku) → ready?       │
│   2. If not ready → inline A/B/C questions    │
│   3. If ready → tightener (Sonnet) drafts spec│
│   4. Spec dispatched to subagents             │
└────────────────┬──────────────────────────────┘
                 ▼
   Subagents work in your repo with MCP access:
     cairn_decisions_in_scope, cairn_invariant_get,
     cairn_canonical_for_topic, cairn_search, …
                 │
                 ▼
   Reviewer subagent attests the diff,
   extracts non-obvious decisions as drafts
                 │
                 ▼
   Stop hook surfaces inline:
     "Review DEC-0099 draft? [a] accept [b] reject [c] edit"
                 │
                 ▼
   You commit → pre-commit hook runs sensors
              → CI gate verifies on PR
              → drift caught before merge
```

## Features

- 🧠 **Persistent memory across sessions.** Decisions, invariants, brand
  voice, canonical-map — all version-controlled in `.cairn/`. Every new
  Claude Code session reads them automatically.
- 🔧 **Heavy adoption pipeline.** One-time pass over your repo: ingests
  existing docs, source-comment essays, and `CLAUDE.md` / `AGENTS.md`
  rules. Classifies them into decisions, invariants, and canonical
  references via Haiku batches.
- 🛡️ **Sensors.** Layer-A (stub catalog), Layer-B (attestation), Layer-D
  (structural). Decision-assertions evaluated mechanically on every diff.
  Run at pre-commit, again at CI.
- 🪝 **Plugin hooks.** SessionStart injects scope. PostToolUse on Read
  enriches with citations. Stop hook surfaces drift + reviewer hints +
  bypass detection.
- 👥 **Multi-developer enforcement.** Versioned git hooks + `cairn join`
  bootstrap + CI gate + plugin degraded mode. Every contributor runs
  Cairn or commits don't merge.
- 🔍 **MCP server.** 21 typed tools. Read tools (`cairn_decision_get`,
  `cairn_search`, …) + locked write tools (`cairn_record_decision`,
  `cairn_resolve_attention`, …) + history-summarizer for archive.
- 🎨 **Cairn Lens** — VS Code / Cursor extension shows the same citation
  context inline as you edit. Same ground state, no separate index.

## Editor Extension — Cairn Lens

Hover, ghost text, gutter icons, code lens — all resolved live from
`.cairn/ground/` ledgers. Read-only.

| Status | Meaning |
|--------|---------|
| `●` (green) | Active invariant |
| `◐` (amber) | Superseded — see chain |
| `○` (red) | Orphan — not in ledger |

Install the latest `.vsix` from
[releases](https://github.com/isaacriehm/cairn/releases) → `Cmd/Ctrl+Shift+P`
→ `Extensions: Install from VSIX…`. Full setup in
[`packages/cairn-lens/README.md`](packages/cairn-lens/README.md).

## Multi-Developer Enforcement

Once a project is Cairn-adopted, every developer runs Cairn — locally
and at PR time. **Defense in depth:**

| Layer | What | Catches |
|-------|------|---------|
| **1. Versioned git hooks** | `.cairn/git-hooks/{pre,post,commit-msg}-commit` | Local commits violating ground state. |
| **2. `cairn join` bootstrap** | CLI + `package.json prepare` script | Clones that haven't activated `core.hooksPath`. |
| **3. CI gate** | `.github/workflows/cairn-check.yml` | `--no-verify` slipping through. **Non-bypassable.** |
| **4. Plugin degraded mode** | SessionStart banner + MCP guard | Write tools refuse with `BOOTSTRAP_REQUIRED` until bootstrap. |

Plus **Stop-hook bypass detection** — surfaces `[a] backfill / [b]
accept (record DEC) / [c] defer` for any HEAD commits not in the
attested-commits log.

## Disk Layout

After `cairn init`:

```
.cairn/
├── config.yaml              slug, version, project_globs
├── config/                  workflow.md, sensors.yaml, …
├── ground/
│   ├── decisions/           <id>.md per DEC + _inbox/<id>.draft.md
│   ├── invariants/          <id>.md per §V
│   ├── canonical-map/       topic → file index
│   ├── brand/               overview.md, voice.md
│   ├── product/             positioning.md, personas.yaml
│   └── scope-index.yaml     file → DEC/§V resolution
├── baseline/                sensor + source-comment + rules audits
├── tasks/active/<id>/       spec.tightened.md, attestation.yaml
├── sessions/<session-id>/   per-session status + events marker
├── git-hooks/               pre-commit, post-commit, commit-msg
├── backups/source/          .original snapshots
└── JOIN.md                  new-contributor bootstrap doc
```

Full contract: [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md).

## Documentation

| Doc | What |
|-----|------|
| [Architecture](docs/ARCHITECTURE.md) | Locked layered model, four-package boundary |
| [Plugin Architecture](docs/PLUGIN_ARCHITECTURE.md) | Adoption phases, hooks, multi-dev enforcement |
| [MCP Surface](docs/MCP_SURFACE.md) | Tool-by-tool reference |
| [Filesystem Layout](docs/FILESYSTEM_LAYOUT.md) | `.cairn/` directory contract |

## Development

```bash
git clone https://github.com/isaacriehm/cairn
cd cairn
pnpm install
pnpm -r build

# 22 smokes — all green on a clean tree
for s in plugin-layout resolve-attention stop-hook events session-state \
         status-line session-start handoff scope-index read-enrich init \
         ingestion-baseline tier0 gc lock source-comments rules-merge join \
         bypass-detection bootstrap-guard e2e-adoption e2e-daily-flow; do
  pnpm --filter @isaacriehm/cairn "smoke:$s"
done
```

## Status

Pre-1.0. Plugin path (Claude Code) is the daily-driven surface; CLI is
the bootstrap and debug entrypoint. Open issues + PRs welcome.

## License

[MIT](LICENSE) © Isaac Riehm

---

<div align="center">
<sub>Built with Claude Code. The plugin architecture takes cues from OpenAI's "harness lesson" on agent state — Cairn extends those ideas with explicit decisions, invariants, sensors, and a multi-developer enforcement layer for solo-or-small-team product engineering.</sub>
</div>
