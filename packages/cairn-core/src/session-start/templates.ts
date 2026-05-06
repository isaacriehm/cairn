/**
 * Static text fragments for the SessionStart payload. Kept compact —
 * every static byte here ships in `additionalContext` on every session
 * open, so verbosity scales linearly with operator session count.
 *
 * The agent's MCP client already receives full tool descriptions from
 * the server's `registerTool` calls; SessionStart does NOT need to
 * duplicate them. Bare `§DEC-NNNN` and `§INV-NNNN` citations resolve
 * via the PostToolUse(Read) enricher hook.
 */

export const TWO_ZONE_REMINDER_BASE =
  "## Two-zone reminder\n\n" +
  "Reads/grep/glob default to the canonical zone (AGENTS.md, CLAUDE.md, " +
  "docs/**, .cairn/ground/**, .cairn/tasks/active/**). Historical content " +
  "(.archive/, .cairn/tasks/done/) is excluded by cairn's walkers — call " +
  "`cairn_query_history(scope, question)` when you need a summarized read.";

export const SESSION_START_HEADER = "# Cairn ground state — authoritative for this session";

/**
 * The code-change contract — system-level rule injected on every
 * SessionStart so it sits above any skill body in the agent's context
 * window. This is the operator-facing equivalent of the cairn-direction
 * skill's "Hard contract" section, restated as a plain instruction
 * Claude reads BEFORE the user prompt. Bypass detection in
 * write-guardian remains the deterministic enforcement; this section
 * is the up-front guidance.
 */
export const CODE_CHANGE_CONTRACT =
  "## Cairn — code-change contract (BLOCKING)\n\n" +
  "Source mutations (`Edit`/`Write` on tracked files) require a tightened " +
  "spec first. Bypass → `PostToolUse` hook returns `decision: \"block\"`.\n\n" +
  "Workflow on any code-change prompt:\n\n" +
  "1. `ToolSearch(select:mcp__plugin_cairn_cairn__cairn_task_create," +
  "mcp__plugin_cairn_cairn__cairn_decisions_in_scope," +
  "mcp__plugin_cairn_cairn__cairn_invariants_in_scope,AskUserQuestion)` — " +
  "load deferred schemas. Required first call; without it `AskUserQuestion` " +
  "is unavailable and clarifications fall back to inline prose.\n" +
  "2. `cairn_decisions_in_scope({path_globs})` + `cairn_invariants_in_scope({path_globs})`.\n" +
  "3. Forks unresolved → `AskUserQuestion` (≤3 options/round, A/B/C, cite " +
  "DEC/§INV per option). Loop until deterministic.\n" +
  "4. `cairn_task_create({slug, title, goal, target_path_globs, " +
  "in_scope_decisions, in_scope_invariants, constraints, out_of_scope, " +
  "acceptance, module})` — server allocates `task_id` + atomically writes " +
  "`spec.tightened.md` + `status.yaml`. Format-locked. **`title`** ≤50 " +
  "chars renders in the statusline + lens (e.g. \"Fix token expiry\"). " +
  "**`goal`** is the full 1–2 sentence description for the spec body.\n" +
  "5. Edit/Write. Hook passes (active tightened task on disk).\n\n" +
  "`/cairn-direction` is the long-form variant (multi-chunk dispatch, " +
  "rich tightening). Above 5 steps = entire flow for straight bug fixes. " +
  "NEVER skip Step 1 or Step 4.";
