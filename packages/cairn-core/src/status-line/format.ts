import type { StatusJson } from "./index.js";

/**
 * Render a single-line status string for Claude Code's status_line hook.
 *
 * Layout: `⬡ cairn  [signal]  [ctx-meter]`
 *
 * Signal priority (first match wins, blank when nothing applies):
 *   bypass_count > 0     → `⚠ N unattested`
 *   attention_count > 0  → `⚑ N pending` (drafts + baseline findings + drift)
 *   gc_running           → `◐ gc`
 *   task_state != idle   → `${task_id} ${task_module}` (or fallbacks)
 *
 * Ctx meter is omitted when no payload is supplied. Color thresholds are
 * keyed on absolute used tokens (not percentage) so a 1M-window Opus
 * session and a 200k-window Sonnet session signal danger at comparable
 * absolute exhaustion points.
 */

export interface CtxMeterInput {
  /** raw used % matches Claude Code's /context display (no buffer normalization). */
  usedPct: number;
  /** absolute used tokens — keys the color threshold. */
  usedTokens: number;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_ORANGE = "\x1b[38;5;208m";
const ANSI_RED = "\x1b[31m";

function ctxColor(usedTokens: number): string {
  if (usedTokens < 100_000) return ANSI_GREEN;
  if (usedTokens < 300_000) return ANSI_YELLOW;
  if (usedTokens < 600_000) return ANSI_ORANGE;
  return ANSI_RED;
}

export function renderCtxMeter(ctx: CtxMeterInput): string {
  const pct = Math.max(0, Math.min(100, Math.round(ctx.usedPct)));
  const filled = Math.floor(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${ctxColor(ctx.usedTokens)}${bar} ${pct}%${ANSI_RESET}`;
}

function renderSignal(s: StatusJson): string | null {
  if (s.bypass_count > 0) return `⚠ ${s.bypass_count} unattested`;
  if (s.attention_count > 0) {
    // attention_count rolls up DEC drafts + baseline sensor findings +
    // drift events, not just drafts. "pending" is the generic noun
    // that fits the union; the cairn-attention skill renders the
    // breakdown when the operator engages.
    return `⚑ ${s.attention_count} pending`;
  }
  if (s.gc_running) return "◐ gc";
  if (s.task_state !== "idle") {
    if (s.task_id && s.task_module) return `${s.task_id} ${s.task_module}`;
    if (s.task_id) return s.task_id;
    if (s.task_module) return s.task_module;
    return `task: ${s.task_state}`;
  }
  return null;
}

export function formatStatus(s: StatusJson, ctx?: CtxMeterInput): string {
  const parts: string[] = ["⬡ cairn"];
  const signal = renderSignal(s);
  if (signal) parts.push(signal);
  if (ctx) parts.push(renderCtxMeter(ctx));
  return parts.join("  ");
}
