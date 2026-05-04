/**
 * Static text fragments for the SessionStart payload.
 */

export const TWO_ZONE_REMINDER_BASE = `## Two-zone reminder

Default reads/grep/glob hit the **canonical zone** only:
- AGENTS.md, CLAUDE.md, .claude/{rules,agents,skills}, docs/**,
  .cairn/config/**, .cairn/ground/** (excluding _inbox/),
  .cairn/tasks/active/**

Historical content lives under .archive/, .cairn/runs/terminal/,
.cairn/tasks/{done,archived}/, .cairn/ground/decisions/_inbox/. The
cairn walkers and search tooling already exclude these paths — you do
not need to filter manually. If you genuinely need to consult historical
context, call \`mcp__cairn__cairn_query_history(scope, question)\`. It
returns LLM-summarized claims with supersedes-pointers; raw archive
content never enters your context.`;

export const TOOL_QUICK_REFERENCE = `## Cairn MCP tools (quick reference)

Read:
  cairn_decision_get(id)                  — full ADR + assertions
  cairn_decisions_in_scope(path_globs[])  — decisions overlapping a path
  cairn_invariant_get(id)                 — §V invariant body + sensor
  cairn_canonical_for_topic(topic)        — authoritative path + verified-at
  cairn_get_full(id, kind)                — fetch any artifact by id
  cairn_search(query, scope[]?)           — substring index over ground+docs
  cairn_query_history(scope, question)    — Tier-1 summary of .archive/

Write:
  cairn_record_decision(...)              — drop draft to _inbox/ for operator confirm
  cairn_archive(path, reason)             — move canonical → .archive/
`;

export const SESSION_START_HEADER = `# Cairn state context

This Claude Code session is running inside a cairn-adopted project. The
cairn state layer has prepared the following grounding context for you.
Treat each section as authoritative for the duration of this session.`;
