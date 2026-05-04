/**
 * Static text fragments for the SessionStart payload.
 */

export const TWO_ZONE_REMINDER_BASE = `## Two-zone reminder

Default reads/grep/glob hit the **canonical zone** only:
- AGENTS.md, CLAUDE.md, .claude/{rules,agents,skills}, docs/**,
  .harness/config/**, .harness/ground/** (excluding _inbox/),
  .harness/tasks/active/**

Historical content lives under .archive/, .harness/runs/terminal/,
.harness/tasks/{done,archived}/, .harness/ground/decisions/_inbox/. The
harness walkers and search tooling already exclude these paths — you do
not need to filter manually. If you genuinely need to consult historical
context, call \`mcp__harness__harness_query_history(scope, question)\`. It
returns LLM-summarized claims with supersedes-pointers; raw archive
content never enters your context.`;

export const TOOL_QUICK_REFERENCE = `## Harness MCP tools (quick reference)

Read:
  harness_decision_get(id)                  — full ADR + assertions
  harness_decisions_in_scope(path_globs[])  — decisions overlapping a path
  harness_invariant_get(id)                 — §V invariant body + sensor
  harness_canonical_for_topic(topic)        — authoritative path + verified-at
  harness_get_full(id, kind)                — fetch any artifact by id
  harness_search(query, scope[]?)           — substring index over ground+docs
  harness_query_history(scope, question)    — Tier-1 summary of .archive/

Write:
  harness_record_decision(...)              — drop draft to _inbox/ for operator confirm
  harness_archive(path, reason)             — move canonical → .archive/
`;

export const SESSION_START_HEADER = `# Harness state context

This Claude Code session is running inside a harness-adopted project. The
harness state layer has prepared the following grounding context for you.
Treat each section as authoritative for the duration of this session.`;
