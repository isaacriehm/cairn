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

This directory holds files that were once canonical but are no longer current. **It is committed history, not deletion.** Per `docs/FILESYSTEM_LAYOUT.md` §2 it is Cairn's `historical` zone.

## What lives here

- Pre-Cairn state files moved out at adoption (e.g. `2026-05-pre-cairn/STATE.md`)
- Documents superseded by an ADR (the new ADR cites the archived path)
- Stale generated artifacts whose source has been removed
- Completed runs' terminal artifacts (auto-moved by Cairn)

## What does NOT live here

- Files marked `[STALE]` in canonical paths — Cairn rejects this pattern. Stale files are MOVED here, never banner-flagged in place.
- Branches or tagged refs — `.archive/` is filesystem-only.
- Secrets — `.env*` patterns stay in `.gitignore` regardless.

## Layout convention

```
.archive/
├── README.md
├── 2026-05-pre-cairn/      ← one bucket per migration / adoption / cleanup wave
│   └── <original-path>       ← preserves the file's prior path inside the bucket
└── <YYYY-MM-DD>/             ← daily quarantine drops
    └── <original-path>
```

## Reading from `.archive/`

Agents do **not** read this directory directly. Soft enforcement, three layers:

1. The `cairn hook session-start` SessionStart hook injects a reminder instructing the agent that historical paths are off-default.
2. Cairn walkers (manifest build, GC sweep, sensor scans) exclude `.archive/` from canonical-zone reads.
3. The only sanctioned read path is the MCP tool:

```
cairn_query_history(scope, question)
```

`cairn_query_history` walks `.archive/` (matched by `path_hint` + `since`/`until`), runs a Tier-1 Haiku summarizer, and returns structured per-claim records with source citations and supersedes-pointers. The agent receives only the summary — raw stale content never enters its context.

PreToolUse-style interception is **not** used (operator decision 2026-05-04). The combination of SessionStart instruction + walker exclusion + `cairn_query_history` is sufficient and avoids the brittleness of a hot-path tool-call hook.

## Writing to `.archive/`

Only via `cairn_archive(path, reason)`. Direct moves are accepted but discouraged because they bypass the audit log. The MCP tool records the reason and timestamp.

## Why we don't delete

1. Decisions cite archived paths. Deletion breaks the audit trail.
2. The init script's mapper agent learns from prior moves what's project-specific.
3. Historical context is occasionally re-needed (e.g. confirming an old decision's premise). Quarantine preserves that without polluting canonical reads.

## Restoring an archived file

`cairn restore <path>` (CLI subcommand, future) — moves a file out of `.archive/<bucket>/` back to its original location and logs the restoration. Use sparingly.
