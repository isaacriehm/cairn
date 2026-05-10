---
type: workflow-policy
status: draft
audience: dual
generated: 2026-05-02T13:19:00Z
verified-at: 2026-05-02T13:19:00Z
source-commits:
  - manual

# ──────────────────────────────────────────────────────────────────────────────
# Project-extension placeholder.
#
# At adoption, the init script REPLACES this block with a real key matching
# the adopting project's `package.json name` (or directory name, lowercased,
# with non-alphanumerics → underscores).
#
# Cairn package code reads this block by `Object.keys()` lookup — never by
# hardcoded project name.
# ──────────────────────────────────────────────────────────────────────────────

<project_name>:
  off_limits:
    - .git/**
    - .archive/**
    - .env
    - .env.local
    - node_modules/**
    # adopting project extends with its own off-limits paths at init
  high_stakes_globs: []                 # populated at init from stack-profile heuristic + operator confirm
  trust_posture:
    safe_class_auto_merge: true
    code_class_auto_merge: false
    high_stakes_auto_merge: false

---

# Workflow policy

This file is the on-disk surface for the **project-extension block** that
`cairn-core/src/sensors/runner.ts` reads (via `Object.keys()` lookup) and
that the Phase-3 init mapper patches with discovered globs and sensors.

The plugin-era cairn does NOT use this file as a per-task prompt template
— each task's spec lives at `.cairn/tasks/active/<task_id>/spec.tightened.md`
and is written directly by the `cairn-direction` skill. The reviewer
subagent reads that spec; nothing renders this markdown body.

If you're looking for the daily flow, see `docs/SYSTEM_OVERVIEW.md` §4.
