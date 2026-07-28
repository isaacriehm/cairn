# cairn-mine — dev-internal datamining tool

> **For the Cairn-coding AI agent.** This tool is NOT shipped. It lives
> in the repo so an AI working on Cairn can pull signal out of real
> Claude Code session JSONLs (its own + other monitored projects) and
> turn 100MB of raw transcript noise into 2KB of actionable context.

## When to use

You should reach for `cairn-mine` whenever you need to:

- Survey what happened in a recent (or historical) Claude Code session.
- Find every place the AI hit `<tool_use_error>` so you can fix the bug.
- Trace a Cairn adoption pipeline run (init phases, attention picks).
- Pull a tool-usage histogram across sessions to find regressions.
- Cross-reference what an AI tried with the resulting `.cairn/` state.
- Compare two production codebases that ran Cairn for a divergent
  behavior pattern.

You should **not** use it for one-off ad-hoc `jq` queries — for those
just call `jq` directly on the JSONL. Mine starts paying off once you
need projection + truncation + per-session aggregation.

## Invocation

```bash
node tools/mine/mine.mjs <subcommand> [flags]
```

Subcommands:

| sub        | what                                                         |
| ---------- | ------------------------------------------------------------ |
| `ls`       | List sessions present in the supplied JSONL(s).              |
| `session`  | Render full timeline for one session.                        |
| `histogram`| Per-tool call counts + token totals + failure rate.          |
| `errors`   | Errors (tool + hook), paired to initiating tool_use.         |
| `cairn`    | Cairn-specific signal — MCP calls, phases, attention, DECs.  |
| `help`     | Print top-level usage.                                       |

Per-subcommand help:

```bash
node tools/mine/mine.mjs <subcommand> --help
```

## Sources

Default: every JSONL under `~/.claude/projects/`.

Override with:

- `--jsonl <path>` — explicit transcript file. Repeatable.
- `--jsonl-glob <pattern>` — glob. Repeatable.
- `--repo <prefix>` — keep only sessions whose `cwd` starts with prefix.
- `--session <uuid>` — restrict to one session uuid.

Examples:

```bash
# One transcript
--jsonl '<operator-home>/.claude/projects/<project-key>/abc...jsonl'

# All sessions in a project's history
--jsonl-glob '<operator-home>/.claude/projects/<project-key>/*.jsonl'

# Every session across every project that touched a given repo
--repo /path/with spaces/example-repo
```

## Time + tool filters

- `--since ISO` — drop events before timestamp.
- `--until ISO` — drop events at or after timestamp.
- `--tool NAME` — keep only tool_use of NAME (and its tool_result).
  Repeatable.
- `--errors-only` — keep only error events.
- `--include-meta` — keep snapshot/attachment events (off by default).

## Output formats

- `--format md` — markdown for AI context. Default.
- `--format ndjson` — one JSON event per line for piping.
- `--limit N` — cap output. Each op has its own default. Pass `0`
  for unlimited.

## Truncation policy

Big strings (assistant text, tool args, tool_result bodies, code diffs)
are head+tail+marker truncated by default so a 100-event timeline
stays in budget. Override per-field:

- `--head 600 --tail 300` — adjust the per-string limit.
- `--full text` — disable text truncation.
- `--full args` — disable tool args truncation.
- `--full result` — disable tool_result truncation.
- `--full all` — disable everything.
- `--unlimited` — alias for `--full all`.

Code edits (`Edit` / `Write` / `MultiEdit`) get a tighter treatment:
filename + line range + head-N / tail-N of the diff, never the whole
file body.

Fields that are **never** truncated regardless of policy:
`file_path`, `path`, `command`, `url`, `tool_name`, `skill`,
`subagent_type`, `query`. These carry the most signal per byte.

## ProjectedEvent shape (ndjson rows)

```ts
{
  session_id: string,
  uuid?: string,
  parent_uuid?: string | null,
  ts?: string,                     // ISO
  kind: "user_text" | "assistant_text" | "thinking"
      | "tool_use" | "tool_result"
      | "system" | "attachment"
      | "permission" | "title" | "last_prompt" | "snapshot",
  tool?: string,                   // tool_use only
  tool_use_id?: string,
  is_error?: boolean,
  status?: "ok" | "error",
  text?: string,                   // user/assistant/thinking
  args?: Record<string, unknown>,  // tool_use, truncated
  result_text?: string,            // tool_result, truncated
  edit?: {                         // Edit / Write / MultiEdit
    path?: string,
    kind: "edit" | "write" | "multi-edit",
    lines_changed?: number,
    head?: string                  // head N + tail M of diff
  },
  tok_in?: number,
  tok_out?: number,
  cache_read?: number,
  cache_create?: number,
  cwd?: string,
  git_branch?: string,
  cc_version?: string,
  dur_ms?: number,                 // system events
  hook_count?: number,             // system events
  hook_errors?: string[],          // system events
  subtype?: string                 // system events
}
```

## Common AI workflows

### "What did I (the AI) just do last session?"

```bash
node tools/mine/mine.mjs ls --jsonl-glob '~/.claude/projects/<project-key>/*.jsonl' --limit 5
# pick the top session id
node tools/mine/mine.mjs session --session <uuid>
```

### "What's breaking on the cairn-adopt skill in production?"

```bash
node tools/mine/mine.mjs cairn \
  --jsonl-glob '~/.claude/projects/*/*.jsonl' \
  --include errors \
  --limit 20
```

### "Which tools fail most?"

```bash
node tools/mine/mine.mjs histogram \
  --jsonl-glob '~/.claude/projects/*/*.jsonl' \
  --sort err_rate \
  --limit 15
```

### "Show me every Edit error on /path/to/repo for the last week"

```bash
node tools/mine/mine.mjs errors \
  --jsonl-glob '~/.claude/projects/*/*.jsonl' \
  --repo /path/to/repo \
  --since 2026-05-05T00:00:00Z \
  --tool Edit \
  --include patterns
```

### "Trace one adoption pipeline run end-to-end"

```bash
node tools/mine/mine.mjs session --session <uuid> --tool Skill --tool mcp__plugin_cairn_cairn__cairn_init_run
```

### "Dump everything for a session to ndjson for jq"

```bash
node tools/mine/mine.mjs session --session <uuid> --format ndjson --limit 0 > /tmp/session.ndjson
jq -c 'select(.kind=="tool_result" and .is_error)' /tmp/session.ndjson
```

## Limitations

- **No `.cairn/` cross-ref yet.** `--cairn <path>` flag is reserved for
  milestone 2 — joining session events to `.cairn/_inbox/` drafts,
  `.cairn/journal/<task>.jsonl`, sensor findings, and git log.
  Today the flag is silently ignored.
- **No multi-jsonl session resolution from `--session` alone**: when
  you pass `--session <uuid>` you also need at least one `--jsonl` or
  `--jsonl-glob` (defaulted to `~/.claude/projects/**/*.jsonl`) to
  search across. The op walks every supplied source filtering by uuid.
- **Thinking blocks are usually empty in JSONL** — Claude Code redacts
  internal thinking text; only the signature lands on disk. `_think_`
  rows render as `_(redacted)_` so the cadence is still visible.

## Operating principles

- **No env vars.** Every flag is positional/`--flag`. Operator hates env.
- **Hardcoded user-home default.** The default glob is
  `os.homedir() + "/.claude/projects/**/*.jsonl"`. Override with
  `--jsonl-glob`.
- **No build step.** Plain `.mjs`. Run via `node`.
- **Cache is opt-in only.** Today nothing caches. If we add caching we
  put it in `tools/mine/.cache/` (gitignored).
- **Streaming everywhere.** Multi-hundred-MB transcripts must not
  blow node's heap. All parsing is line-by-line via `readline`.

## Roadmap

- **Milestone 1** ✓ — JSONL-only ops (ls, session, histogram, errors, cairn).
- **Milestone 2** — `--cairn <path>` cross-ref. Join sessions to
  `_inbox/`, `journal/`, `sensors/`. Add `mine deltas` op for spec
  changes mined per-session.
- **Milestone 3** — `--repo <path>` git-log join. Detect which
  decisions made it into commits vs. got abandoned.
