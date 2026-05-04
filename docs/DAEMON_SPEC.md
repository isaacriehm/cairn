---
type: spec
status: draft-v1
audience: dual
generated: 2026-05-04
depends-on:
  - docs/PRIMER.md
  - docs/DOCS_SPEC.md
  - docs/FILESYSTEM_LAYOUT.md
---

# Harness — Grounding Daemon Spec

The grounding daemon is the background process that keeps `.harness/ground/` continuously fresh. It runs alongside Claude Code sessions and requires no operator attention during normal operation.

---

## 1. What the daemon is

A long-lived Node process started by `harness watch` (or as a system service by `harness daemon start`). It does three things:

1. **Watches** the canonical zone for file changes
2. **Regenerates** generated docs when their sources change
3. **Serves** the MCP server (`harness mcp serve`) for agent tool calls

These can run in a single process or be split. Default: `harness watch` runs both watcher + MCP server in one process. `harness daemon start` registers it as a launchd/systemd service so it survives terminal closes.

---

## 2. What triggers the daemon

| Trigger | What happens |
|---------|-------------|
| Source file changes (chokidar watch) | Check which generators have this file in their `source_globs`; re-run those generators |
| New file appears in canonical zone | Validate frontmatter; add to docs-index; check canonical-map for gaps |
| Decision draft appears in `_inbox/` | Notify via active frontend adapter: "New decision draft pending confirm" |
| `harness gc` called manually | Run full GC five-pass sweep |
| GC cron fires (nightly, configurable) | Run full GC five-pass sweep |
| Manifest becomes stale | Rebuild manifest from scratch |

The daemon does NOT watch:
- `.archive/` (historical zone — changes there are only commits, not live edits)
- `.harness/runs/` (gitignored; runtime concern)
- `.harness/inbox/` (gitignored; runtime concern)
- `node_modules/`
- Paths in `.gitignore`

---

## 3. Generator execution

When a source file change triggers a generator:

```
source file changes
    ↓
find all generators whose source_globs match the changed path
    ↓
for each generator (parallel):
    run generator command in repo root
    capture stdout + stderr
    if exit 0:
        diff output vs current .harness/ground/<output>
        if diff non-empty:
            write new content
            bump verified-at in docs-index
            stage + commit: "chore(gc): regenerate <generator-id>"
    if exit non-zero:
        write failure to .harness/staleness/log.jsonl
        notify via active frontend adapter (if registered)
        do NOT update the output file — keep last known good
```

Generators run in the mirror checkout, not the user's working tree. Commits from generator runs go directly to the mirror's `main`.

**Debounce:** file change events are debounced 2s before triggering. Rapid saves (e.g. running `pnpm format`) don't re-run generators on every keystroke.

**Concurrency:** generators for the same output path are queued (not parallelized). Generators for different output paths run in parallel.

---

## 4. Manifest rebuild

The manifest (`.harness/ground/manifest.yaml`) is a complete index of every file in the canonical zone. The daemon rebuilds it:
- On startup
- After any generator run that changes a file
- After any GC pass
- On explicit `harness manifest rebuild`

Rebuild is a full walk of the canonical zone (uses `ground/walk.ts` `walkCanonical` — hardcodes `.archive` + historical roots to SKIP_DIRS). For each file:
- Compute sha256
- Read frontmatter (if markdown/yaml)
- Classify (decision, invariant, rule, guide, generated, etc.)
- Write entry to manifest

Manifest rebuild is always a clean overwrite, not an incremental update. Fast enough that incremental isn't worth the complexity.

---

## 5. Docs-index maintenance

The docs-index (`.harness/ground/docs-index/index.yaml`) is a richer index focused on doc health. Updated by the daemon on every manifest rebuild:

- For each file with frontmatter: extract `type`, `status`, `audience`, `verified-at`, `source-commits`
- Compute `needs_reverification`: true if `verified-at < (now - 30 days)` AND any `source-commits` SHA has new commits since `verified-at`
- Update the entry

Docs-index is what the GC frontmatter-freshness pass reads. It's also what the SessionStart hook reads to select context injection candidates.

---

## 6. `verified-at` bumping

The daemon bumps `verified-at` automatically when it can confirm the doc is still current without human involvement:

| Condition | Action |
|-----------|--------|
| Generated doc, generator ran successfully, output unchanged | Bump `verified-at` to now |
| Hand-authored doc, `source-commits` SHAs unchanged since last `verified-at` | Bump `verified-at` to now |
| Hand-authored doc, `source-commits` SHAs have new commits | Set `needs_reverification: true` in docs-index — do NOT bump |
| Doc has `source-commits: ["manual"]` and is < 30 days old | Bump `verified-at` to now |
| Doc has `source-commits: ["manual"]` and is > 30 days old | Flag for operator — "This manually-authored doc hasn't been verified in 30+ days" |

The daemon never modifies a hand-authored doc's content. It only modifies the frontmatter `verified-at` field when safe to do so, and only in committed files (never in working-tree edits — always via a clean `git commit`).

---

## 7. Decision draft watcher

When a new `.md` file appears in `.harness/ground/decisions/_inbox/`:

1. Parse the draft's frontmatter and title
2. Notify via the active frontend adapter: "New decision draft `<DEC-id>`: `<title>`. [Confirm | Reject | View]"
3. On operator confirm: move file from `_inbox/` to `.harness/ground/decisions/<DEC-id>.md`, append to `decisions.ledger.yaml`, commit `feat(decisions): accept DEC-<id>`
4. On operator reject: delete draft from `_inbox/`

If no frontend adapter is registered (bare install, no Discord/Notion/CLI adapter active): decision drafts accumulate in `_inbox/` until `harness decisions review` is run manually.

---

## 8. GC cron

Default schedule: nightly at 02:00 local time (configurable in `workflow.md` frontmatter: `gc_cron: "0 2 * * *"`).

GC runs in the mirror checkout. Autonomy-first — it fixes everything it can without asking, reports what it did, escalates only what it can't resolve.

Each pass:
1. Pull latest from origin
2. Run the five-pass sweep (see `DOCS_SPEC.md §4`)
3. **Auto-commit all safe-class changes** — no operator confirm, no dialog. `chore(gc): <description>` committed and pushed immediately.
4. **Auto-archive clearly-stale docs** — orphaned doc (100% of referenced symbols deleted, no ambiguity) → moved to `.archive/<today>/` automatically.
5. **Auto-create missing doc stubs** — new module detected with no canonical-map entry → stub created with frontmatter + heading structure, queued for agent fill-in.
6. Write GC summary to `.harness/staleness/log.jsonl`
7. Update `status.json` (`attention_count` += items that need a human decision)
8. If anything genuinely requires operator decision (ambiguous orphan, generator command failed, doc with multi-module ownership): add to attention queue. Operator sees `attention:N ⚑` in status line and runs `harness attention` when convenient.

GC never runs while a task run is active. Deferred until run closes.

---

## 9. Process lifecycle

### Startup

```
harness watch
    ↓
load config from .harness/config/workflow.md
load docs-index, manifest
    ↓
start MCP server (stdio or TCP, per config)
start file watcher (chokidar) on canonical zone
    ↓
run startup checks:
  - verify .harness/ground/ integrity (manifest sha256 spot-check)
  - verify all registered generators have their commands available
  - flag any generators whose output is older than source (detected generator drift)
    ↓
ready — log "harness daemon ready" to stderr
```

### Shutdown

Clean shutdown on SIGTERM/SIGINT:
1. Stop accepting new watcher events
2. Finish in-flight generator runs (with 10s timeout — force-kill after)
3. Flush any pending manifest/docs-index writes
4. Stop MCP server
5. Exit 0

Unclean shutdown (crash, kill -9): next startup detects incomplete state via a lockfile (`~/.local/harness/state/<project>/daemon.lock`) and runs a recovery manifest rebuild before accepting watcher events.

### Mirror sync

On startup, the daemon checks if the mirror is behind origin:
- If yes: `git fetch && git reset --hard origin/main` (no agent run in progress)
- If a run is in progress: skip sync — mirror is pinned to the run's SHA

On each GC commit push: standard `git push origin main`. If push fails (conflict): surface to operator — "GC push failed due to conflict. Run `harness gc --retry` after pulling."

---

## 10. Configuration surface

All daemon config lives in `.harness/config/workflow.md` frontmatter. Relevant fields:

```yaml
---
# daemon config
gc_cron: "0 2 * * *"          # nightly GC schedule (cron syntax)
gc_auto_merge: true            # auto-commit safe-class GC changes
manifest_rebuild_on_change: true  # rebuild manifest on every canonical-zone change
mcp_port: null                 # null = stdio (default); integer = TCP port
daemon_log_level: info         # debug | info | warn | error
watch_debounce_ms: 2000        # file change debounce
generator_timeout_ms: 30000    # per-generator timeout
---
```

---

## 11. What the daemon does NOT do

- Does not write to the user's working tree — only to the mirror checkout
- Does not run agent processes
- Does not manage task queues or run lifecycles (runtime concern)
- Does not manage frontend adapter connections (runtime concern)
- Does not read `.archive/` or any historical zone paths
- Does not run expensive LLM calls — the only LLM calls are in GC pass 4 (missing-coverage doc stub proposal, Tier 1) and only when new modules are detected
