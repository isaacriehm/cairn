# Quick reference

Compact lookups for CLI commands, MCP tools, status-line meaning,
file locations, and slash commands. Concept explanations live in
the other guides; this is the cheat sheet.

---

## CLI commands

The CLI is `cairn`. Installed at user level via the Claude Code
plugin (bundled, accessed via `node "$(cat ~/.claude/plugins/cache/isaacriehm-cairn/.active-version-path)" <subcommand>`)
or directly via `npm install -g @isaacriehm/cairn`.

### Bootstrap and adoption

| Command                        | What                                                                  | When                                                                   |
| ------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cairn init`                   | Run the 13-phase adoption pipeline from a terminal.                   | When you'd rather drive adoption from a shell than from Claude Code.   |
| `cairn join`                   | Bootstrap this clone — set `core.hooksPath`, verify CLI version.      | First time on a clone. Idempotent — safe to re-run.                    |
| `cairn doctor`                 | Health check — ledger integrity, hook installation, version pin. Exits 0 on advisory warnings (errors → 1). | When something feels off; safe as a CI health gate.   |
| `cairn doctor --strict`        | Same health check, but exit 2 when any warning is present.            | When you want warnings to hard-fail a CI job.                          |
| `cairn uninstall`              | Preview de-adoption — expand DEC/INV cites to inline comments, then remove `.cairn/`, the rule import, and the hook path. Changes nothing without `--yes`. | When you're considering removing Cairn.                |
| `cairn uninstall --yes`        | Apply de-adoption. `--keep-cites` leaves the `§DEC-/§INV-` tokens in source instead of inlining them. | When you want the project back to its pre-adoption state. |

### Daily work

| Command                                  | What                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `cairn attention`                        | Drain the pending-attention queue interactively.                         |
| `cairn migrate`                          | Bring `.cairn/` state up to the current cairn version.                   |
| `cairn scope --files <a>,<b>`            | Show DECs and §INVs in scope for the listed files.                       |
| `cairn scope rebuild`                    | Force-rebuild `scope-index.yaml` from source citations.                  |

### Sensors and gates

| Command                                  | What                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `cairn sensor-run --staged`              | Run the sensor sweep against the staged diff. Used by pre-commit hook.   |
| `cairn sensor-run --diff <range>`        | Run sensors against an arbitrary diff range. Used by CI gate.            |
| `cairn sensor-run --strict`              | Hard-fail on warnings (used by CI for stricter gating).                  |
| `cairn baseline`                         | Re-run the Phase 11 baseline sweep.                                      |

### GC and maintenance

| Command                                  | What                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `cairn gc`                               | Run all five GC passes (drift / completion / scope / quality / staleness). |
| `cairn gc --pass drift`                  | Run only the drift pass.                                                 |
| `cairn fix`                              | Apply mechanical remediation for known-fixable findings.                 |
| `cairn invariants prune`                 | Retire junk invariants the Layer A hook minted before the creation gate (sot-align-sourced, no constraint shape). `--all` resets every sot-align INV; `--dry-run` previews. Archives to `.cairn/ground/.archive/`. |
| `cairn cites expand`                     | Replace `// §DEC-/§INV-` citation lines with the entity body inline, as a plain comment. `--dry-run` previews. |

### Inspection

| Command                                  | What                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `cairn trace`                            | Pretty-print the unified trace log.                                      |
| `cairn trace --tail`                     | Follow live (like `tail -f`).                                            |
| `cairn trace --errors-only`              | Filter to errors.                                                        |
| `cairn trace --session <id>`             | Filter to one session.                                                   |
| `cairn trace --json`                     | Raw JSONL, pipeable.                                                     |
| `cairn tag`                              | List tags applied to current run / session.                              |
| `cairn status-line`                      | Print the current status-line text. Used by the Claude Code statusLine   |

### MCP and hooks

| Command                                  | What                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `cairn mcp serve`                        | Start the MCP server (stdio). Registered by the plugin via `.mcp.json`.  |
| `cairn mcp call <tool> '<json>'`         | Call an MCP tool from a shell with a JSON payload.                       |
| `cairn hook session-start`               | Hook runner for the SessionStart event.                                  |
| `cairn hook stop`                        | Hook runner for the Stop event.                                          |
| `cairn hook post-tool-use/read`          | PostToolUse(Read) — citation enrichment.                                 |
| `cairn hook post-tool-use/write`         | PostToolUse(Write\|Edit) — scope-index sync.                             |
| `cairn hook session-end`                 | Hook runner for SessionEnd.                                              |

---

## MCP tools by category

The MCP server exposes 25 typed tools. Source of truth is
`packages/cairn-core/src/mcp/tools/index.ts`.

### Read — graph traversal

| Tool                          | Returns                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `cairn_decision_get`          | Full DEC by id (frontmatter + assertions + body).                      |
| `cairn_in_scope`              | DEC + §INV summaries whose `scope_globs` overlap supplied path-globs; filter via `types: ["decision"|"invariant"]`. |
| `cairn_invariant_get`         | Full §INV by id.                                                       |
| `cairn_canonical_for_topic`   | `topic → { canonical_path, sha256, verified_at }`.                     |

### Read — search and retrieval

| Tool                       | Returns                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `cairn_search`             | FTS over canonical-zone artifacts. Compact records (~50 tokens each).    |

### Read — historical (gated)

| Tool                  | Returns                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `cairn_query_history` | Only path to `.archive/`. LLM-summarized; raw stale never enters context. |

### Write — append-only

| Tool                    | What                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `cairn_record_decision` | Drop new DEC draft to `_inbox/`. Id is content-addressed (`DEC-` + 7 hex).          |
| `cairn_task_create`     | Create `.cairn/tasks/active/<id>/` with spec.tightened.md + status.yaml. |

### Attention queue

| Tool                          | What                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| `cairn_resolve_attention`     | Resolve a single item (DEC / finding / drift / conflict / bypass).  |
| `cairn_attention_dedup`       | Cluster near-duplicate drafts by Jaccard ≥ 0.4.                     |

### Init pipeline

The 13-phase adoption pipeline lives behind a single
`cairn_init_run` dispatcher. The skill loops on `cairn_init_resume`
→ `cairn_init_run` until `nextPhase === null`. Phase 8
(`8-docs-ingest`) internally fans out to phases 8/9/10 in parallel and
advances to `11-baseline` — no separate parallel tool needed.

| Tool                | What                                                                                |
| ------------------- | ----------------------------------------------------------------------------------- |
| `cairn_init_resume` | Read `.cairn/init-state.json` and return the next phase id (or `null` when done).   |
| `cairn_init_run`    | Dispatch a specific phase by id (`{ phase, answer? }`). Persists state on success.  |

Phase IDs (passed as `phase` arg): `1-detect`, `2-walker`, `3-mapper`,
`4-seed`, `5-pilot`, `6-brand`, `7-topic-index`, `8-docs-ingest`,
`9-source-comments`, `10-rules-merge`, `11-baseline`, `12-strip`,
`13-multidev`.

### Calling MCP tools from a shell

```bash
cairn mcp call cairn_decision_get '{"id":"DEC-a3f7b2c"}'

cairn mcp call cairn_in_scope '{"path_globs":["src/auth/**"]}'

cairn mcp call cairn_canonical_for_topic '{"topic":"rate limiting"}'

cairn mcp call cairn_search '{"query":"idempotency","limit":5}'
```

The same tools the agent uses, available from your shell for
debugging or scripting.

---

## Status-line badge

The Claude Code status-line shows the Cairn badge when wired via
`/cairn-statusline-setup` or auto-wired during adoption. Format:

```
⬡ cairn  <state>  TSK-… <task title>
```

### Colors

| Color  | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| Green  | Clean state. No pending attention, no drift, no bypass alerts.                         |
| Amber  | Non-zero attention but nothing actively blocking. Drain when convenient.               |
| Red    | Active blocker. Drift + bypass + pending all > 0, or an unresolved hard conflict.      |

### Icons

| Icon | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `⚑`  | Pending attention items (DEC drafts, findings, drift, bypass).                     |
| `⏳`  | Long-running phase in progress (mainly during adoption).                           |
| `⚠`  | Conflict or bypass detected.                                                       |
| `✓`  | Recent successful sensor sweep.                                                    |

### Numbers

```
⬡ cairn ⚑ 3 pending  TSK-2026-05-09-fix-token-expiry Fix token expiry
```

- `3 pending` — items in the attention queue.
- `TSK-2026-05-09-fix-token-expiry` — active task id.
- `Fix token expiry` — task title (truncated to fit).

During adoption:

```
⬡ cairn ⏳ adopt 9-source-comments 24/47 (51%) ~3m
```

- `9-source-comments` — current phase.
- `24/47 (51%)` — progress within the phase.
- `~3m` — estimated remaining time.

Token usage tinting (when enabled): the badge background color
reflects absolute token usage in the current session — useful when
you're approaching context limits.

---

## File locations

A consolidated map of where everything lives.

### Canonical (committed)

```
.cairn/
├── config.yaml                                    project slug, version, off_limits, domain
├── config/
│   ├── workflow.md                                per-task prompt template + cfg
│   ├── sensors.yaml                               sensor registry
│   ├── stub-patterns.yaml                         Layer A regex catalog
│   └── trust-policy.yaml                          per-command trust posture
├── ground/
│   ├── manifest.yaml                              {path, sha256, verified_at, …} per file
│   ├── decisions/
│   │   ├── DEC-<hash>.md                            accepted decisions
│   │   └── decisions.ledger.yaml                  compact summary, always-loaded
│   ├── invariants/
│   │   ├── INV-<hash>.md                            §INV invariants
│   │   └── invariants.ledger.yaml                 compact summary
│   ├── canonical-map/
│   │   ├── topics.yaml                            topic → canonical-doc-path
│   │   └── citations/                             per-topic citations
│   ├── scope-index.yaml                           file → DEC/§INV resolution
│   ├── brand/                                     brand ground state
│   ├── product/                                   positioning + personas
│   ├── conflicts/                                 unresolved DEC↔INV contradictions
│   ├── alignment-pending/                         queued SoT-align cases for review
│   └── quality-grades.yaml                        per-module score from GC
├── tasks/active/<task-id>/
│   ├── spec.tightened.md                          tightened spec — agent reads this
│   ├── status.yaml                                handoff state for resume
│   └── attestation.yaml                           reviewer subagent's report
├── baseline/
│   └── sensor-audit-<ts>.yaml                     Phase 11 sweep audit
├── git-hooks/
│   ├── pre-commit                                 sensor sweep
│   ├── post-commit                                append SHA to .attested-commits
│   └── commit-msg                                 optional DEC/TSK ref validation
├── backups/source/                                Phase 12 .original snapshots
└── JOIN.md                                        bootstrap doc for new contributors
```

### Gitignored (per-clone runtime)

```
.cairn/
├── runs/                                          per-run scratch + outputs
├── inbox/                                         raw frontend-adapter ingress
├── transcripts/                                   voice transcripts (when shipped)
├── sessions/<session-id>/
│   ├── status.json                                live session state
│   └── events-marker.txt                          events poll cursor
├── events/                                        cross-session invalidation events
├── staleness/
│   ├── current.json                               live drift snapshot
│   └── log.jsonl                                  drift event log
├── ground/decisions/_inbox/                       DEC drafts awaiting accept/reject
├── ground/decisions/_inbox/<id>.rejected.md       rejected drafts (id stays reserved)
├── init-state.json                                adoption resume cursor
├── .write-lock                                    per-write flock target
├── .gc-lock                                       GC sweep mutex
├── .audit-lock                                    audit operation mutex
└── .attested-commits                              SHAs that passed pre-commit
```

### Per-machine (outside repo)

```
~/.cairn/
├── trace/
│   └── trace-YYYY-MM-DD.jsonl                     unified trace log (every hook + tool + subprocess)
├── repos/<project-slug>/                          mirror checkout (reserved for future)
├── state/<project-slug>/                          non-portable runtime state
└── models/                                        optional model cache (reserved)
```

### Plugin install location

```
~/.claude/plugins/cache/isaacriehm-cairn/
├── dist/cli.mjs                                   bundled CLI entry
├── .active-version-path                           pointer for status-line shim
├── hooks/                                         hook bin entrypoints
├── skills/                                        cairn-adopt, cairn-direction, cairn-attention, …
├── agents/                                        reviewer subagent
└── commands/                                      slash commands
```

### Project files Cairn touches

```
<repo-root>/
├── .gitignore                                     adds .cairn runtime entries
├── .github/workflows/cairn-check.yml              CI gate (Phase 13, GitHub-hosted)
├── package.json                                   prepare script (Node projects, Phase 13)
└── JOIN.md                                        moved here from .cairn/ at adoption end
```

---

## Slash commands

| Command                       | What                                                                    | When to use                                            |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `/cairn-init`                 | Trigger the adoption pipeline explicitly.                               | When you declined the auto-prompt earlier and want to  |
|                               |                                                                         | adopt now.                                             |
| `/cairn-direction <prompt>`   | Force the direction skill to engage on the supplied prompt.             | When auto-invoke missed (operator's prompt didn't      |
|                               |                                                                         | match the trigger gate but you wanted tightening).     |
| `/cairn-statusline-setup`     | Wire the `⬡ cairn` status-line badge into `~/.claude/settings.json`.   | One-time per machine. Adoption offers it auto.         |
| `/cairn-attention`            | Drain the pending-attention queue inline.                               | When you want to drain off-cycle (the skill            |
|                               |                                                                         | auto-invokes when SessionStart flags pending items).   |

### Auto-invocation

You don't usually call these. The plugin's skill descriptions
trigger auto-invocation:

| Skill              | Auto-invoke when                                                        |
| ------------------ | ----------------------------------------------------------------------- |
| `cairn-adopt`      | Project has no `.cairn/` and operator hasn't permanently declined.      |
| `cairn-direction`  | UserPromptSubmit looks like a code-change ask (verbs, bug reports, …).  |
| `cairn-attention`  | SessionStart context flags `attention_count > 0`.                       |

Manual slash invocation is the escape hatch when auto-invoke didn't
fire on a borderline prompt.

---

## Env vars (none)

Cairn deliberately uses **no environment variables**. Model IDs are
hardcoded; paths are derived from `cwd` walks; project root is
detected by walking up for `.cairn/` or `.git/`.

If you see something asking for `CAIRN_*` env vars, it's stale doc
or a third-party fork.

---

## Common one-liners

A scratch list of useful invocations.

### List all in-scope decisions for a file

```bash
cairn scope --files src/auth/jwt.ts
```

### Check the bypass count

```bash
cairn doctor | grep bypass
```

### Tail the live trace

```bash
cairn trace --tail
```

### Drain attention from a terminal (no Claude Code)

```bash
cairn attention
```

### Re-run the baseline audit

```bash
cairn baseline
```

### See what the Phase 11 baseline found

```bash
ls -1t .cairn/baseline/sensor-audit-*.yaml | head -1 | xargs cat
```

### Write a quick decision from the shell

```bash
cairn mcp call cairn_record_decision '{
  "title": "Use ULID instead of UUID for new IDs",
  "summary": "Sortable, time-prefixed, db-friendly.",
  "scope_globs": ["src/**"],
  "body_markdown": "## Decision\n\nULID for all new entity IDs. Existing UUID IDs stay."
}'
```

### Search for any decisions about retries

```bash
cairn mcp call cairn_search '{"query":"retry","kinds":["decision","invariant"]}'
```

### Force-rebuild the scope index

```bash
cairn scope rebuild
```

---

## What to read next

- [`concepts.md`](concepts.md) — the seven core concepts.
- [`daily-flow.md`](daily-flow.md) — what every session looks like.
- [`adoption.md`](adoption.md) — the one-time install per project.
- [`decisions.md`](decisions.md) — DEC creation and scope design.
- [`multi-dev.md`](multi-dev.md) — onboarding contributors.
