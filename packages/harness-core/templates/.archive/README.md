---
type: rule
status: accepted
audience: dual
generated: 2026-05-02T13:19:00Z
verified-at: 2026-05-02T13:19:00Z
source-commits:
  - manual
---

# `.archive/` — quarantine zone

This directory holds files that were once canonical but are no longer current. **It is committed history, not deletion.** Per `docs/FILESYSTEM_LAYOUT.md` §2 it is the harness's `historical` zone.

## What lives here

- Pre-harness state files moved out at adoption (e.g. `2026-05-pre-harness/STATE.md`)
- Documents superseded by an ADR (the new ADR cites the archived path)
- Stale generated artifacts whose source has been removed
- Completed runs' terminal artifacts (auto-moved by the harness)

## What does NOT live here

- Files marked `[STALE]` in canonical paths — the harness rejects this pattern. Stale files are MOVED here, never banner-flagged in place. (See `docs/PRIMER.md` §11 anti-patterns.)
- Branches or tagged refs — `.archive/` is filesystem-only.
- Secrets — `.env*` patterns stay in `.gitignore` regardless.

## Layout convention

```
.archive/
├── README.md
├── 2026-05-pre-harness/      ← one bucket per migration / adoption / cleanup wave
│   └── <original-path>       ← preserves the file's prior path inside the bucket
└── <YYYY-MM-DD>/             ← daily quarantine drops
    └── <original-path>
```

## Reading from `.archive/`

Agents do **not** read this directory directly. The `.claude/settings.json` PreToolUse hook denies `Read | Grep | Glob` calls whose paths match `.archive/**`. The only sanctioned read path is the MCP tool:

```
harness_query_history(scope, question)
```

The harness daemon reads, an LLM summarizes, the agent receives the summary — never the raw stale doc. This is what keeps stale content out of agent context windows.

## Writing to `.archive/`

Only via `harness_archive(path, reason)`. Direct moves are accepted but discouraged because they bypass the audit log. The MCP tool records the reason, the operator who issued the move (frontend-adapter user-id), and the timestamp.

## Why we don't delete

1. Decisions cite archived paths. Deletion breaks the audit trail.
2. The init script's mapper agent learns from prior moves what's project-specific.
3. Historical context is occasionally re-needed (e.g. confirming an old decision's premise). Quarantine preserves that without polluting canonical reads.

## Restoring an archived file

`harness restore <path>` (CLI subcommand, future) — moves a file out of `.archive/<bucket>/` back to its original location and writes a `harness_record_run_event` of the restoration. Use sparingly.
