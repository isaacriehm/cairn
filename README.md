# Cairn

State + context-loading layer for AI coding agents. Stops drift between what
your project knows and what agents do.

A cairn is a stack of stones marking a trail. This project stacks the
decisions, invariants, and canonical references that define your codebase
into a queryable ground state — so every agent that opens your repo has the
same map.

> **Status:** pre-1.0. The plugin path (Claude Code) is the daily-driven
> surface; the CLI is the bootstrap and debug entrypoint. Public repo,
> permissive license forthcoming.

## What it does

- **Curates `.cairn/ground/`** — every binding architectural decision,
  domain invariant, brand voice rule, and canonical-map topic for your
  project, version-controlled in markdown + YAML.
- **Exposes ground state via an MCP server** — agents query
  `cairn_decisions_in_scope`, `cairn_invariants_in_scope`,
  `cairn_canonical_for_topic`, etc. instead of guessing or fabricating.
- **Visible adoption** — `/cairn-init` (or auto-detected by the plugin)
  walks the project once, classifies your existing docs, source comments,
  and rule files, and seeds ground state from what's already there.
- **Daily flow** — operator types a prompt, the plugin's tightener turns it
  into a spec, dispatch runs subagents, the reviewer extracts non-obvious
  decisions as drafts. Inline A/B/C lets you accept, reject, or edit.
- **Multi-developer enforcement** — versioned git hooks, per-clone bootstrap
  (`cairn join`), CI gate, and Claude Code degraded mode mean every
  contributor runs Cairn or commits don't merge.

## Key concepts

| Concept | What |
|---------|------|
| **Decision (DEC-NNNN)** | A binding architectural choice with rationale, scope globs, supersedes chain. Stored at `.cairn/ground/decisions/<id>.md`. |
| **Invariant (§V&lt;N&gt;)** | A domain rule whose violation is a bug, not a style preference. Stored at `.cairn/ground/invariants/<id>.md`. |
| **Canonical map** | `topic → file` index. The single source of truth for "where does X live". |
| **Sensor** | A deterministic check against staged diffs (or the full repo at adoption). Layer-A through Layer-D enforcement. |
| **Attention queue** | DEC drafts + baseline findings + invalidation events surfaced inline to the operator as `[a]/[b]/[c]` choices. |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the locked layered
model and [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) for
the Claude Code plugin spec.

## Quick start (Claude Code)

```bash
# Inside Claude Code, in a project root:
/plugin install cairn@isaacriehm-cairn
```

The plugin's SessionStart hook detects an unadopted project and surfaces an
inline `[a] adopt now / [b] not now / [c] never` prompt. Pick `[a]` once and
adoption walks every phase: submodule init, priority walk, mapper, brand
setup, docs ingestion, source-comment ingestion, rules merge, baseline
sensor sweep, multi-dev install. Agents in your next session start with full
ground state.

## Quick start (CLI)

```bash
npm install -g @isaacriehm/cairn
cd /path/to/your/project
cairn init             # one-time adoption
cairn join             # one-time per-clone bootstrap (idempotent)
cairn doctor           # verify everything is wired
cairn attention        # see the pending DEC drafts and baseline debt
```

For a new contributor cloning an already-adopted project, `cairn join` is
the only command they need. The `package.json` `prepare` script runs it
automatically on `npm install` for Node projects.

## Architecture

```
Cairn
├── packages/cairn-core                  state + MCP + tier0 + sensors + GC + hooks
├── packages/cairn                       umbrella CLI (init, join, hook, doctor, …)
├── packages/cairn-frontend-claudecode   Claude Code plugin (manifest, hooks, skills, agents, commands)
├── packages/cairn-frontend-stub         in-memory test adapter
└── packages/cairn-lens                  VS Code / Cursor extension (DEC explorer)
```

Public packages: `cairn-core` and `cairn`. Internal packages stay in the workspace: `cairn-frontend-claudecode`, `cairn-frontend-stub`, `cairn-lens`. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3 for
the layer-by-layer breakdown.

## Multi-developer enforcement

Once a project is Cairn-adopted, every developer who touches it runs Cairn
— locally and at PR time. Four layers per
[`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) §17:

| Layer | Where | Catches |
|-------|-------|---------|
| 1 — versioned git hooks | `.cairn/git-hooks/{pre,post,commit-msg}-commit` | Local commit attempts that violate ground state. |
| 2 — `cairn join` bootstrap | CLI + `package.json prepare` | New clones that haven't activated `core.hooksPath`. |
| 3 — CI gate | `.github/workflows/cairn-check.yml` | `git commit --no-verify` bypass slipping through. Non-bypassable. |
| 4 — plugin degraded mode | Claude Code SessionStart + MCP guard | Write tools refuse with `BOOTSTRAP_REQUIRED` until bootstrap. |

Plus Stop-hook bypass detection — surfaces inline `[a] backfill / [b] accept
(record DEC) / [c] defer` for any HEAD commits not in `.attested-commits`.

## Disk layout in an adopted project

```
.cairn/
├── config.yaml                   slug, cairn_version, project_globs, sensors
├── config/                       workflow.md, sensors.yaml, stub-patterns.yaml, trust-policy.yaml
├── ground/
│   ├── manifest.yaml             auto-regenerated index
│   ├── decisions/                <id>.md per DEC, plus _inbox/<id>.draft.md
│   ├── invariants/               <id>.md per §V
│   ├── canonical-map/topics.yaml topic → canonical_path
│   ├── brand/                    overview.md, voice.md
│   ├── product/                  positioning.md, personas.yaml
│   ├── capabilities/             skills.yaml, mcp-tools.yaml, snippets.yaml
│   ├── quality-grades.yaml
│   └── scope-index.yaml          file → DEC/§V/topic resolution
├── baseline/                     sensor-audit, source-comments, rules-merge, suppressions
├── tasks/active/<id>/            spec.tightened.md, attestation.yaml
├── sessions/<session-id>/        per-Claude-Code-session status.json + events-marker
├── events/                       invalidation events (7-day retention)
├── git-hooks/                    pre-commit, post-commit, commit-msg
├── backups/source/               .original snapshots for Phase 10 strip-replace
└── JOIN.md                       new-contributor bootstrap doc
```

See [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md) for the
canonical reference.

## Documentation

| File | What |
|------|------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Locked layered model, four-package boundary |
| [`docs/PLUGIN_ARCHITECTURE.md`](docs/PLUGIN_ARCHITECTURE.md) | Claude Code plugin spec — adoption phases, MCP surface, hooks, multi-dev |
| [`docs/PRIMER.md`](docs/PRIMER.md) | Concept walkthrough |
| [`docs/MCP_SURFACE.md`](docs/MCP_SURFACE.md) | Tool-by-tool MCP reference |
| [`docs/FILESYSTEM_LAYOUT.md`](docs/FILESYSTEM_LAYOUT.md) | `.cairn/` directory contract |
| [`docs/WORKFLOW_GUIDE.md`](docs/WORKFLOW_GUIDE.md) | Operator UX rules + tier ladder |

## Development

```bash
pnpm install
pnpm -r build
pnpm --filter @isaacriehm/cairn check:layout

# Smoke suite (22 tests as of v0.1.0)
for s in plugin-layout resolve-attention stop-hook events session-state status-line \
         session-start handoff scope-index read-enrich init ingestion-baseline \
         tier0 gc lock source-comments rules-merge join bypass-detection \
         bootstrap-guard e2e-adoption e2e-daily-flow; do
  pnpm --filter @isaacriehm/cairn "smoke:$s"
done
```

The build sequence and per-step BUILD_LOG live under
[`cairn-build/`](cairn-build/).

## License

MIT (pending — see [`LICENSE`](LICENSE) once added).

## Acknowledgements

The plugin architecture takes cues from OpenAI's cairn lesson on agent
state management. Cairn extends those ideas with explicit decisions,
invariants, sensors, and a multi-developer enforcement layer suited to
solo-or-small-team product engineering with Claude Code as the primary
agent surface.
