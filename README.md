<div align="center">

# Cairn

**Keeps AI coding agents consistent with the decisions your project already made.**

[![npm](https://img.shields.io/npm/v/@isaacriehm/cairn?style=flat-square&logo=npm&color=CB3837)](https://www.npmjs.com/package/@isaacriehm/cairn)
[![ci](https://img.shields.io/github/actions/workflow/status/isaacriehm/cairn/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/isaacriehm/cairn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

Plugin for Claude Code, Cursor, and Codex · MCP server · pre-commit and CI checks

</div>

---

## The problem

Monday you tell your agent "auth tokens expire after 24 hours." It ships.

Friday, new session. The agent reads `auth/tokens.ts`, sees nothing about
expiry, and "improves" it to a 7-day refresh. You catch it in review, or you
don't.

The model isn't bad. It has no memory of what you decided. A bigger context
window only delays the problem. Cairn keeps a version-controlled record of
your decisions in the repo, loads the relevant ones into every agent session,
and checks every diff against them at commit time and again in CI.

## 20-second example

A decision recorded with a machine-checkable assertion:

```json
{
  "title": "Auth tokens expire after 24 hours",
  "scope_globs": ["src/auth/**"],
  "assertions": [{ "id": "a1", "kind": "text_must_match",
                   "pattern": "TOKEN_TTL_SECONDS = 24 \\* 60 \\* 60;",
                   "in_globs": ["src/auth/tokens.ts"] }]
}
```

Then a change that drifts from it:

```console
$ git diff -U0 -- src | tail -2
-export const TOKEN_TTL_SECONDS = 24 * 60 * 60;
+export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

$ git commit -am "perf(auth): extend token TTL to 7 days"
ERROR decision-assertions: DEC-674be42/a1 text_must_match `TOKEN_TTL_SECONDS = 24 \* 60 \* 60;` — no file under src/auth/tokens.ts matches

Cairn pre-commit gate FAILED — 1 hard finding(s). Fix them, then re-commit (or `git commit --no-verify` to bypass; the bypass is flagged at the next session and caught by CI).
```

That output is real, captured from `@isaacriehm/cairn@0.33.0` installed
from npm into a fresh repo. The [full transcript](docs/demo.md) also shows a
compliant edit to the same file committing cleanly, a `throw new Error("not
implemented")` stub being blocked, and the CI check catching a
`--no-verify` bypass.

In daily use you don't write that JSON. The agent records decisions through
Cairn's MCP tools, and adoption pulls existing ones out of your docs, code
comments, and `CLAUDE.md` / `AGENTS.md`. Most decisions carry no assertion.
They work by being loaded into the agent's context before it touches
in-scope files.

## Quick start

Requires Node 22+ and git.

### In your agent (recommended)

**Claude Code**

```bash
/plugin marketplace add isaacriehm/cairn
/plugin install cairn@isaacriehm-cairn
/reload-plugins
```

**Codex (CLI and Desktop)**

```bash
codex plugin marketplace add isaacriehm/cairn
codex plugin add cairn@cairn
```

In Codex Desktop, restart after adding the source, open **Plugins**, and
install **Cairn**. Codex asks you to trust the bundled hooks before they run.

**Cursor**

```
Settings → Cursor → Plugins → Add from GitHub → isaacriehm/cairn
```

Then open a session in any git repo. Cairn's SessionStart hook offers to
adopt the project. Accept once. Adoption runs inline and reads your docs,
source comments, and agent rule files into `.cairn/`. The run time depends
on repo size. From then on every session starts with the relevant decisions
loaded, and Cairn wires its git hooks into each clone at session start.

The plugin bundles its own CLI and MCP server, so there's nothing to
`npm install`. Model-backed steps go through the CLI of the host that loaded
the plugin (`claude`, `cursor-agent`, or `codex`), so no separate API key is
needed.

In Claude Code, turn off the built-in auto-memory (`/memory → Disable
Auto-Memory`). Cairn is the memory layer, and the two conflict.

### CLI only

```bash
npm install -g @isaacriehm/cairn
cd your-repo
cairn init          # interactive adoption
cairn join          # activates the git hooks in this clone
cairn doctor        # health check
git add -A && git commit -m "chore: adopt cairn"
```

`cairn init --no-prompt` adopts without prompts for scripts and CI. It skips
the model-backed mapper and doc ingestion, so it starts with an empty
decision ledger. Each new clone runs `cairn join` once. The plugin does this
automatically at session start.

## How it works

```
 agent session                          git
 ─────────────                          ───
 SessionStart / Read hooks ──┐          pre-commit ── cairn sensor-run --staged
 MCP tools (32) ─────────────┤                         │
                             ▼                         ▼
                      .cairn/ground/   ◄──── stub-pattern catalog
                      decisions, invariants,  decision assertions
                      canonical map           (same sweep in CI:
                                               cairn sensor-run --diff <range> --strict)
```

- **Ground state.** `.cairn/ground/` holds decision records (`DEC-<hash>`),
  invariants (`§INV-<hash>`, rules whose violation is a bug), and a
  canonical map from topic to file. It's plain markdown and YAML, committed
  with your code. Each record has a scope glob, so the agent only sees what
  applies to the files it's touching.
- **Context loading.** Plugin hooks inject in-scope decisions at session
  start and when the agent reads a file. The MCP server exposes 32 tools for
  querying and recording state (`cairn_in_scope`, `cairn_decision_get`,
  `cairn_canonical_for_topic`, `cairn_search`, `cairn_record_decision`, …).
- **Enforcement.** The pre-commit hook runs a sensor sweep over the staged
  diff. Hard findings block the commit. Adoption installs a
  `cairn-check.yml` workflow that runs the same sweep on every PR, so
  `--no-verify` doesn't get through. Two sensors block today: the stub-pattern
  catalog and decision assertions.
- **Local only.** No hosted service. Telemetry is a local file under
  `.cairn/`. The network calls are model calls through your agent's CLI and
  one npm version check per day.

### Packages

| Package | What it is |
| --- | --- |
| [`cairn`](packages/cairn) | The `cairn` CLI (`init`, `join`, `doctor`, `sensor-run`, `mcp serve`, …). Published as `@isaacriehm/cairn`. |
| [`cairn-core`](packages/cairn-core) | MCP server, sensors, hook runners, and the adoption pipeline. |
| [`cairn-state`](packages/cairn-state) | Ground-state schemas and read-only I/O, shared by core and Lens. |
| [`cairn-plugin`](packages/cairn-plugin) | One plugin for Claude Code, Cursor, and Codex: thin host manifests over a shared bundle, skills, and agents. |
| [`cairn-lens`](packages/cairn-lens) | VS Code / Cursor extension. Hover and gutter context for `§INV` / `DEC` citations. Ships as a `.vsix` on [Releases](https://github.com/isaacriehm/cairn/releases). |

The layer boundaries are fixed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Status and limits

- **Pre-1.0, one maintainer.** Breaking changes land in minor versions as
  hard cutovers, and `cairn migrate` moves existing `.cairn/` state forward.
  See the [changelog](CHANGELOG.md).
- **Mechanical checks are narrow.** Assertions are regex and structural
  checks over the diff, not semantic review. Most decisions are enforced by
  being in the agent's context, not by a sensor.
- **Model-backed steps need an authenticated agent CLI** (`claude`,
  `cursor-agent`, or `codex`). Adoption uses one to map the repo and extract
  decisions from your docs.
- **One `core.hooksPath` per repo.** If husky, lefthook, or a custom hooks
  directory already holds it, Cairn leaves it alone and says so. The
  pre-commit sweep stays off until you chain Cairn's hooks, but CI still
  runs it.
- **CI runs on Ubuntu with Node 22.** Development happens on macOS. Windows
  isn't covered by CI.
- **Cairn Lens isn't on the VS Code Marketplace.** Install the `.vsix` from
  Releases. It checks npm once a day for a newer version.

## Documentation

| Using Cairn | |
| --- | --- |
| [Core concepts](docs/guide/concepts.md) | Decisions, invariants, canonical map, scope, sensors, drift. |
| [Adoption](docs/guide/adoption.md) | The one-time adoption pipeline, phase by phase. |
| [Daily flow](docs/guide/daily-flow.md) | What happens on every prompt after adoption. |
| [Decisions](docs/guide/decisions.md) | File format, supersedes chains, assertions, scope design. |
| [Teams](docs/guide/multi-dev.md) | Onboarding contributors, the CI gate, bypass detection. |
| [Reference](docs/guide/reference.md) | CLI commands, MCP tools, status line, file locations. |

| Changing Cairn | |
| --- | --- |
| [System overview](docs/SYSTEM_OVERVIEW.md) | End-to-end surface map. |
| [Architecture](docs/ARCHITECTURE.md) | Layered model and package boundaries (locked). |
| [Plugin architecture](docs/PLUGIN_ARCHITECTURE.md) | Adoption phases, hooks, multi-dev enforcement. |
| [MCP surface](docs/MCP_SURFACE.md) | Tool-by-tool reference. |
| [Filesystem layout](docs/FILESYSTEM_LAYOUT.md) | The `.cairn/` directory contract. |

## Troubleshooting

**`cairn-direction` never triggers on Sonnet.** Claude Code reserves 1% of
the context window for the skill listing. On a 200k-context model that's
about 2,000 characters, and with several plugins installed the
lowest-priority descriptions get dropped. Adoption raises
`skillListingBudgetFraction` to `0.03` in `~/.claude/settings.json` if it's
lower, and leaves higher values alone. Restart Claude Code after the first
adoption. `/doctor` should report `0 dropped`.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the checks a PR must pass. Report security issues privately per
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Isaac Riehm

---

<div align="center">
<sub>Built with Claude Code and Codex. The plugin architecture takes cues from OpenAI's "harness lesson" on agent state. Cairn extends those ideas with explicit decisions, invariants, sensors, and a multi-developer enforcement layer for solo-or-small-team product engineering.</sub>

<sub>Cursor plugin by <a href="https://github.com/chrismuntean">Chris Muntean</a>.</sub>
</div>
