import type { ProgressSnapshot } from "../init/progress.js";
import { activeEvent, summaryCounterText } from "./event-queue.js";
import type { StatusEvent, StatusJson } from "./index.js";

/**
 * Render a single-line status string for Claude Code's status_line hook.
 *
 * Layout: `⬡ cairn  [signal]  [ctx-meter]`
 *
 * Signal priority (first match wins, blank when nothing applies):
 *   adopt-progress       → `⏳ adopt <phase> <X>/<Y> (P%) ~Nm` (highest;
 *                           live during cairn-adopt long phases)
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

/**
 * Render the live adoption-progress badge from the heartbeat snapshot.
 * Format: `⏳ adopt <phase> <batch>/<total> (P%) ~Nm` — the eta is
 * extrapolated from elapsed time × remaining-fraction. Sub-minute etas
 * collapse to seconds; sub-second etas omit the trailing eta entirely.
 */
function renderProgress(p: ProgressSnapshot): string {
  const pct =
    p.total > 0 ? Math.max(0, Math.min(100, Math.round((p.batch / p.total) * 100))) : 0;
  const elapsedSec = (Date.now() - p.startedAt) / 1000;
  let eta = "";
  if (p.batch > 0 && p.batch < p.total) {
    const etaSec = Math.round(elapsedSec * ((p.total - p.batch) / p.batch));
    if (etaSec >= 60) {
      eta = ` ~${Math.ceil(etaSec / 60)}m`;
    } else if (etaSec > 0) {
      eta = ` ~${etaSec}s`;
    }
  }
  return `⏳ adopt ${p.phase} ${p.batch}/${p.total} (${pct}%)${eta}`;
}

function renderEvent(e: StatusEvent): string {
  switch (e.kind) {
    case "aligned":
      return `⬡ aligned · ${e.primary_id ?? ""}`.trimEnd();
    case "created-dec":
      return `⬡ created · ${e.primary_id ?? "DEC-?"}`;
    case "created-inv":
      return `⬡ created · ${e.primary_id ?? "INV-?"}`;
    case "supplemented":
      return `⬡ supplemented · ${e.primary_id ?? ""} + ${e.secondary_id ?? ""}`;
    case "constrained":
      return `⬡ constrained · ${e.primary_id ?? ""} ← ${e.secondary_id ?? ""}`;
    case "refreshed": {
      const path = e.detail ? ` (${e.detail})` : "";
      return `⬡ refreshed · ${e.primary_id ?? ""}${path}`;
    }
    case "scanning":
      return "⬡ scanning…";
    case "drain-progress":
      return `⬡ aligning ${e.detail ?? ""}…`;
    case "drain-done":
      return `⬡ ${e.detail ?? "drain done"}`;
    case "haiku-offline":
      return "⚠ haiku offline · drain queued";
    default:
      return "⬡ cairn";
  }
}

function renderSignal(
  s: StatusJson,
  progress?: ProgressSnapshot | null,
  nowMs: number = Date.now(),
): string | null {
  if (progress) return renderProgress(progress);
  if (s.bypass_count > 0) return `⚠ ${s.bypass_count} unattested`;

  // Layer-A-emitted events take precedence inside their 10s sticky window
  // so the operator sees what cairn just did before any rolling counter
  // takes over.
  const live = activeEvent(s, nowMs);
  if (live) return renderEvent(live);

  if (s.haiku_unavailable) return "⚠ haiku offline · drain queued";

  if (s.attention_count > 0) {
    // attention_count rolls up DEC drafts + baseline sensor findings +
    // drift events + conflict files, not just drafts. "pending" is the
    // generic noun that fits the union; the cairn-attention skill
    // renders the breakdown when the operator engages.
    return `⚑ ${s.attention_count} pending`;
  }
  if (s.gc_running) return "◐ gc";
  if (s.task_state !== "idle") {
    if (s.task_id && s.task_module) return `${s.task_id} ${s.task_module}`;
    if (s.task_id) return s.task_id;
    if (s.task_module) return s.task_module;
    return `task: ${s.task_state}`;
  }

  // Roll-up from the session-cumulative counters. Persists across the
  // ring buffer's 32-event overflow so the operator always sees totals
  // from session start.
  const summary = summaryCounterText(s.event_counters);
  if (summary !== null) return summary;

  return null;
}

export function formatStatus(
  s: StatusJson,
  ctx?: CtxMeterInput,
  progress?: ProgressSnapshot | null,
  nowMs: number = Date.now(),
): string {
  const parts: string[] = ["⬡ cairn"];
  const signal = renderSignal(s, progress ?? null, nowMs);
  if (signal) parts.push(signal);
  if (ctx) parts.push(renderCtxMeter(ctx));
  return parts.join("  ");
}
