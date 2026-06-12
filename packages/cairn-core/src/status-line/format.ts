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
 *   task_state != idle   → `<short_id> · <short_title>` capped at 45 chars
 *
 * Task display strips the slug from `task_id` (`TSK-<slug>-<7hex>`
 * → `TSK-<7hex>`) and ellipsis-truncates `task_module` so a 14"
 * MacBook Pro terminal stays inside one row. The full id remains the
 * canonical reference on disk + via the lens — the statusline is for
 * human-glance only.
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
  /** absolute window size in tokens (CC's `context_window.total_tokens`). */
  windowTokens: number;
}

/**
 * Mission-cursor segment input. Rendered as
 * `<phase_label> · <done> of <total>` between the signal and the
 * ctx meter when supplied. The phase label is the cursor phase's
 * human title trimmed to ~22 chars at the first `:` / `(` / `+`
 * boundary, so an operator-readable "Wave 4: behavior" surfaces
 * instead of the internal phase id ("wave4-behavior") or the
 * never-disambiguating mission slug.
 */
export interface MissionCursorInput {
  /** Human-readable cursor phase title from the roadmap. */
  phase_title: string;
  done: number;
  total: number;
}

const TASK_SEGMENT_BUDGET = 45;
const MISSION_PHASE_LABEL_BUDGET = 22;

/**
 * Strip the slug from a `TSK-<slug>-<7hex>` id, keeping the prefix +
 * trailing 7-hex hash. Falls back to a generic ellipsis-truncate when
 * the id does not match the canonical shape (defensive — should not
 * happen for ids the server allocates, but external/legacy ids may
 * leak through).
 */
export function shortenTaskId(taskId: string): string {
  const m = taskId.match(/^TSK-.+-([0-9a-f]{7})$/);
  if (m && m[1] !== undefined) return `TSK-${m[1]}`;
  return taskId.length > 14 ? `${taskId.slice(0, 13)}…` : taskId;
}

/**
 * Compose the task signal segment. Both the id and the module/title
 * are size-bounded; either may be null. Returns null when both are
 * absent so the caller can fall through to a generic `task: <state>`
 * placeholder.
 */
export function renderTaskSegment(
  taskId: string | null,
  taskModule: string | null,
): string | null {
  const id = taskId !== null && taskId.length > 0 ? shortenTaskId(taskId) : null;
  const sep = " · ";
  if (id !== null && taskModule !== null && taskModule.length > 0) {
    const moduleBudget = Math.max(8, TASK_SEGMENT_BUDGET - id.length - sep.length);
    const mod =
      taskModule.length > moduleBudget
        ? `${taskModule.slice(0, moduleBudget - 1)}…`
        : taskModule;
    return `${id}${sep}${mod}`;
  }
  if (id !== null) return id;
  if (taskModule !== null && taskModule.length > 0) {
    return taskModule.length > TASK_SEGMENT_BUDGET
      ? `${taskModule.slice(0, TASK_SEGMENT_BUDGET - 1)}…`
      : taskModule;
  }
  return null;
}

export function renderMissionSegment(m: MissionCursorInput): string {
  const label = shortenPhaseTitle(m.phase_title);
  return `${label} · ${m.done} of ${m.total}`;
}

/**
 * Compact the cursor phase title to a glanceable label. Cuts at the
 * first `:`, `(`, or `+` boundary (operators write
 * `"Wave 4: behavior + org-pattern + …"` style titles where the
 * leading segment is the clear short name), then ellipsis-truncates
 * to `MISSION_PHASE_LABEL_BUDGET` chars. Falls back to the raw
 * (truncated) title when no boundary char appears.
 */
function shortenPhaseTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return "phase";
  const cutAt = Math.min(
    ...[":", "(", "+"]
      .map((ch) => trimmed.indexOf(ch))
      .filter((i) => i > 0),
  );
  const head = Number.isFinite(cutAt) ? trimmed.slice(0, cutAt).trimEnd() : trimmed;
  if (head.length <= MISSION_PHASE_LABEL_BUDGET) return head;
  return `${head.slice(0, MISSION_PHASE_LABEL_BUDGET - 1).trimEnd()}…`;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_ORANGE = "\x1b[38;5;208m";
const ANSI_RED = "\x1b[31m";

function ctxColor(pct: number): string {
  if (pct < 50) return ANSI_GREEN;
  if (pct < 70) return ANSI_YELLOW;
  if (pct < 85) return ANSI_ORANGE;
  return ANSI_RED;
}

export function renderCtxMeter(ctx: CtxMeterInput): string {
  const pct = Math.max(0, Math.min(100, Math.round(ctx.usedPct)));
  const filled = Math.floor(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${ctxColor(pct)}${bar} ${pct}%${ANSI_RESET}`;
}

/**
 * Friendly statusline label per progress-writing phase. The user sees
 * this live during adoption, so it must read in plain words — never the
 * internal phase id (`7-topic-index`). Only `3-mapper`, `7-topic-index`,
 * and `9a-walker` emit a progress heartbeat; an unknown id falls back to
 * a generic word rather than leaking the id.
 */
const ADOPT_PHASE_LABEL: Record<string, string> = {
  "3-mapper": "mapping project",
  "7-topic-index": "tidying notes",
  "9a-walker": "reading rules",
};

function adoptPhaseLabel(phase: string): string {
  return ADOPT_PHASE_LABEL[phase] ?? "working";
}

/**
 * Render the live adoption-progress badge from the heartbeat snapshot.
 * Format: `⏳ adopt <label> <batch>/<total> (P%) ~Nm` — the eta is
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
  return `⏳ adopt ${adoptPhaseLabel(p.phase)} ${p.batch}/${p.total} (${pct}%)${eta}`;
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
    const seg = renderTaskSegment(s.task_id ?? null, s.task_module ?? null);
    if (seg !== null) return seg;
    return `task: ${s.task_state}`;
  }

  // Roll-up from the session-cumulative counters. Persists across the
  // ring buffer's 32-event overflow so the operator always sees totals
  // from session start.
  const summary = summaryCounterText(s.event_counters);
  if (summary !== null) return summary;

  // Idle heartbeat — flips the idle state from "silent = healthy" to
  // "visible = healthy" so the operator never has to wonder whether
  // Cairn is alive. Renders only when there is actual ground state in
  // scope; on a fresh adoption with zero decisions the line stays
  // minimal.
  const heartbeat = renderIdleHeartbeat(s);
  if (heartbeat !== null) return heartbeat;

  return null;
}

/**
 * Idle heartbeat — `✓ <N>·<M>` where N = decisions in scope, M = §INV
 * invariants in scope. Returns null when both counts are zero (a brand-
 * new adoption where the load-bearing surfaces haven't filled yet).
 */
function renderIdleHeartbeat(s: StatusJson): string | null {
  const dec = Math.max(0, s.decisions_in_scope ?? 0);
  const inv = Math.max(0, s.invariants_in_scope ?? 0);
  if (dec === 0 && inv === 0) return null;
  return `✓ ${dec}·${inv}`;
}

export function formatStatus(
  s: StatusJson,
  ctx?: CtxMeterInput,
  progress?: ProgressSnapshot | null,
  nowMs: number = Date.now(),
  mission?: MissionCursorInput | null,
): string {
  const parts: string[] = ["⬡ cairn"];
  const signal = renderSignal(s, progress ?? null, nowMs);
  if (signal) parts.push(signal);
  if (mission) parts.push(renderMissionSegment(mission));
  if (ctx) parts.push(renderCtxMeter(ctx));
  return parts.join("  ");
}
