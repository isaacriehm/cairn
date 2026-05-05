import type { StatusJson } from "./index.js";

/**
 * Render a StatusJson as the single-line string Claude Code's status_line hook
 * displays. Pure function; no I/O.
 *
 * Format: `⬡ cairn  decisions:N  inv:N  attention:N  ●`
 *
 * The pre-pivot status string carried `daemon:down` because cairn used to
 * run a long-lived daemon. The plugin pivot retired the daemon; the
 * status field now reports operator-actionable signal: pending attention
 * count first (ranks above tasks), GC sweep state second, task state
 * last.
 *
 * Health icon:
 *   attention > 0  → ⚑
 *   gc running     → ◐
 *   idle / running → ●
 */
export function formatStatus(s: StatusJson): string {
  const parts: string[] = ["⬡ cairn"];

  parts.push(`decisions:${s.decisions_in_scope}`);
  parts.push(`inv:${s.invariants_in_scope}`);

  let stateField: string;
  let icon: string;
  if (s.attention_count > 0) {
    stateField = `attention:${s.attention_count}`;
    icon = "⚑";
  } else if (s.gc_running) {
    stateField = "gc:active";
    icon = "◐";
  } else if (s.task_state !== "idle") {
    stateField = `task:${s.task_state}`;
    icon = "●";
  } else {
    stateField = "ready";
    icon = "●";
  }
  parts.push(stateField);
  parts.push(icon);

  return parts.join("  ");
}
