import type { StatusJson } from "./index.js";

/**
 * Render a StatusJson as the single-line string Claude Code's status_line hook
 * displays. Pure function; no I/O.
 *
 * Field priority for the "state" slot (single field):
 *   daemon down  >  attention > 0  >  gc running  >  task_state
 *
 * Health icon:
 *   daemon down  → ○
 *   attention    → ⚑
 *   else         → ●
 */
export function formatStatus(s: StatusJson): string {
  const parts: string[] = ["⬡ harness"];

  parts.push(`ctx:${s.ctx_tokens_used}/${s.ctx_tokens_budget}`);
  parts.push(`decisions:${s.decisions_in_scope}`);
  parts.push(`inv:${s.invariants_in_scope}`);

  let stateField: string;
  let icon: string;
  if (!s.daemon_alive) {
    stateField = "daemon:down";
    icon = "○";
  } else if (s.attention_count > 0) {
    stateField = `attention:${s.attention_count}`;
    icon = "⚑";
  } else if (s.gc_running) {
    stateField = "gc:active";
    icon = "●";
  } else {
    stateField = `task:${s.task_state}`;
    icon = "●";
  }
  parts.push(stateField);
  parts.push(icon);

  return parts.join("  ");
}
