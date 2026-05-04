---
type: spec
status: draft-v1
audience: dual
generated: 2026-05-04
depends-on:
  - docs/PRIMER.md (§8.0)
  - docs/DAEMON_SPEC.md
---

# Harness — Claude Code Status Line Spec

Harness registers a persistent status line inside every Claude Code session in an adopted project. It shows what the harness is doing at all times — present, readable at a glance, not in the way.

---

## 1. What it looks like

Idle state:
```
⬡ harness  ctx:847/4000  decisions:12  inv:8  task:idle  ●
```

Active run:
```
⬡ harness  ctx:847/4000  decisions:12  inv:8  task:running  ●
```

GC running:
```
⬡ harness  ctx:847/4000  decisions:12  inv:8  gc:active  ●
```

Daemon not running:
```
⬡ harness  ctx:847/4000  decisions:12  inv:8  daemon:down  ○
```

Problem detected (sensor fail, stale docs surfaced, etc.):
```
⬡ harness  ctx:847/4000  decisions:12  inv:8  attention:1  ⚑
```

Fields:
| Field | Meaning |
|-------|---------|
| `ctx:N/M` | Tokens used by this session's SessionStart injection / budget |
| `decisions:N` | Count of accepted decisions in scope of current cwd |
| `inv:N` | Count of active invariants in scope |
| `task:idle\|running\|queued(N)` | Current task state |
| `gc:active` | GC sweep is in progress |
| `daemon:down` | Daemon process not responding |
| `attention:N` | N items need operator input (decision drafts pending, escalated sensor failures) |
| `●` / `○` / `⚑` | Daemon healthy / down / needs attention |

---

## 2. How it's registered

`harness init` writes the status line command to `.claude/settings.json`:

```json
{
  "statusLine": "harness status-line --project-root /path/to/project"
}
```

`harness status-line` is a fast CLI subcommand (< 10ms) that reads `~/.local/harness/state/<project-slug>/status.json` and prints the formatted status string to stdout. Claude Code polls this on its normal refresh cadence.

No subprocess overhead per render beyond a file read — the daemon keeps `status.json` current.

---

## 3. The state file

`~/.local/harness/state/<project-slug>/status.json` — written by the daemon, read by the status line command.

```json
{
  "updated_at": "2026-05-04T14:32:00Z",
  "daemon_alive": true,
  "ctx_tokens_used": 847,
  "ctx_tokens_budget": 4000,
  "decisions_in_scope": 12,
  "invariants_in_scope": 8,
  "task_state": "idle",
  "task_module": null,
  "gc_running": false,
  "attention_count": 0,
  "last_run_result": "succeeded",
  "last_run_at": "2026-05-04T14:20:00Z"
}
```

The daemon writes this file on every state change: task starts/ends, GC starts/ends, attention count changes, daemon startup/shutdown. On normal read-only operations (MCP tool calls, manifest reads) it does not write — no thrashing.

`daemon_alive` is determined by checking if the daemon's PID file (`~/.local/harness/state/<project-slug>/daemon.pid`) is present and the process is alive. The status-line command does this check itself in < 1ms.

If `status.json` is older than 30 seconds and the daemon appears alive: show `ctx` as stale (dim the value). If the daemon is down: show `daemon:down`.

---

## 4. Context bar (`ctx:N/M`)

`ctx_tokens_used` = the token count of the `additionalContext` block injected by the last `SessionStart` hook run for this project. Comes from the hook's own output measurement — it reports its token count to `status.json` after each run.

`ctx_tokens_budget` = the `maxChars` / 4 token estimate configured in `workflow.md` (default 4000 tokens). This is the budget `buildSessionStartContext` respects when truncating lower-priority sections.

Seeing `ctx:3900/4000` means the harness is injecting nearly the full budget — the operator knows the project has a lot of active context. Seeing `ctx:200/4000` means it's a small scope or early project.

---

## 5. Attention items

`attention_count` increments for:
- Decision drafts in `_inbox/` awaiting confirm
- Sensor failures that exhausted auto-repair retries and need operator input
- GC items the harness couldn't resolve autonomously (ambiguous orphan, etc.)

When `attention_count > 0`, operator runs `harness attention` to see the list and resolve items. The status line shows `attention:N ⚑` until all items are cleared.

---

## 6. Task state values

| Value | Meaning |
|-------|---------|
| `idle` | No active run |
| `running` | Claude Code is executing a run right now |
| `queued(N)` | N tasks waiting in FIFO queue |
| `tightening` | Spec tightener running (pre-dispatch) |
| `sensing` | Sensor sweep running (post-agent) |
| `reviewing` | Reviewer subagent running |
| `backprop` | Backprop subagent writing §V invariant |

---

## 7. Implementation

`harness-core` package provides:
- `src/status-line/writer.ts` — `writeStatusJson(repoRoot, patch)`. Daemon calls this.
- `src/status-line/reader.ts` — `readStatusForCLI(repoRoot)` → formatted string. CLI `status-line` subcommand calls this.
- `src/status-line/format.ts` — formats the status fields into the display string. Pure function, no I/O.

The `harness status-line` CLI command is a thin wrapper around `readStatusForCLI`. It must complete in < 10ms including process startup. If startup overhead becomes an issue, the daemon can serve the status line via a local socket instead.
