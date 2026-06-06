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
  "(.cairn/tasks/done/) is excluded by cairn's walkers.";

export const SESSION_START_HEADER = "# Cairn ground state — authoritative for this session";

/**
 * The code-change contract — system-level rule injected on every
 * SessionStart so it sits above any skill body in the agent's context
 * window. The contract is a one-line gate: invoke the cairn-direction
 * skill on any code-change prompt. The skill owns the workflow
 * (ToolSearch preload, in-scope lookup, tightening, dispatch) and is
 * the single source of truth — duplicating the steps here drifts and
 * caused phantom tool refs (`cairn_decisions_in_scope` /
 * `cairn_invariants_in_scope` no longer exist; unified into
 * `cairn_in_scope`).
 */
export const CODE_CHANGE_CONTRACT =
  "## Cairn — code-change contract (BLOCKING)\n\n" +
  "Source mutations (`Edit`/`Write` on tracked files) require a tightened " +
  "spec on disk at `.cairn/tasks/active/<task_id>/status.yaml`. Bypass → " +
  "`PostToolUse` hook returns `decision: \"block\"`.\n\n" +
  "**On any code-change prompt, invoke `Skill(cairn:cairn-direction)` " +
  "before reading or mutating source.** The skill drives the full flow: " +
  "preloads MCP tools + `AskUserQuestion`, gathers in-scope context via " +
  "`cairn_in_scope({path_globs, types?})`, tightens forks, allocates the " +
  "task via `cairn_task_create`, and dispatches implementation.\n\n" +
  "Code-change triggers: task verbs (build/add/fix/refactor/wire/remove), " +
  "bug reports, broken-behavior observations, modal verbs (should/must), " +
  "mission continuation (`continue`/`go`/`next` on an active mission).\n\n" +
  "Skip the skill ONLY for: pure info questions with no implied change, " +
  "operator opt-outs (`skip cairn`, `just do it`), or trivial pinpointed " +
  "edits (`rename foo to bar at f.ts:42`). When in doubt, invoke.";
