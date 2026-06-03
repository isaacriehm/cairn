/**
 * SessionStart hook context builder.
 *
 * Composes the `additionalContext` payload Claude Code injects when a
 * `claude` session opens inside a cairn-adopted project. Spec lives at
 * `docs/SESSIONSTART_SPEC.md`. The hook itself (`cairn hook
 * session-start`) lives in the umbrella CLI and calls
 * `buildSessionStartContext` with the cwd resolved from the SessionStart
 * payload.
 *
 * Two-zone enforcement is soft: this module emits the reminder text +
 * the canonical-only ledgers; canonical-only walkers + the
 * cairn_query_history MCP tool do the rest. There is no PreToolUse
 * hook (PreToolUse is forbidden — see PLUGIN_ARCHITECTURE hard rules).
 */

export {
  buildSessionStartContext,
  gitRepoRoot,
  resolveAnchorRoot,
  resolveRepoRoot,
} from "./build.js";
export type {
  BuildSessionStartContextArgs,
  BuildSessionStartContextResult,
  SessionStartSection,
} from "./build.js";
export { TWO_ZONE_REMINDER_BASE } from "./templates.js";
