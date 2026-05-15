/**
 * Status-line module.
 *
 * The plugin's SessionStart hook writes `.cairn/sessions/<id>/status.json`
 * and Claude Code's status_line hook invokes `cairn status-line` (which
 * reads the same file via `readStatusForCLI`).
 *
 * Spec: PLUGIN_ARCHITECTURE §7 (per-session state partition);
 * docs/STATUS_LINE_SPEC.md (format).
 */

export type TaskState =
  | "idle"
  | "running"
  | "queued"
  | "tightening"
  | "sensing"
  | "reviewing"
  | "backprop";

/**
 * Status-line event kinds emitted by Layer A (PostToolUse alignment),
 * SessionStart Drain (SessionStart drain), and the doc-drift hook.
 *
 * Plan §9.2 — the visible feedback channel for cairn's auto-resolutions.
 * Layer A never writes to chat; the operator sees what cairn did via
 * statusline blips that stay visible for 10s before rolling to the next
 * event or falling back to the session summary counter.
 */
export type StatusEventKind =
  | "aligned"
  | "created-dec"
  | "created-inv"
  | "supplemented"
  | "constrained"
  | "refreshed"
  | "scanning"
  | "drain-progress"
  | "drain-done"
  | "haiku-offline";

export interface StatusEvent {
  /** ms epoch when the event fired. */
  ts: number;
  kind: StatusEventKind;
  /** Primary id displayed in the blip (DEC or INV id). */
  primary_id?: string;
  /** Secondary id (augments-INV, supersedes link, etc.). */
  secondary_id?: string;
  /** Free-form detail (sot-path on refresh, count on drain summary, etc.). */
  detail?: string;
  /** ms epoch — until this time the blip preempts the summary fallback. */
  display_until: number;
}

export interface StatusEventCounters {
  aligned: number;
  created: number;
  supplemented: number;
  constrained: number;
  refreshed: number;
  conflicts_pending: number;
  drift_pending: number;
}

export interface StatusJson {
  /** ISO timestamp of last write. */
  updated_at: string;
  decisions_in_scope: number;
  invariants_in_scope: number;
  task_state: TaskState;
  task_id: string | null;
  task_module: string | null;
  gc_running: boolean;
  attention_count: number;
  bypass_count: number;
  last_run_result: "succeeded" | "failed" | null;
  last_run_at: string | null;
  current_event: StatusEvent | null;
  event_counters: StatusEventCounters;
  haiku_unavailable: boolean;
  /** Ring buffer of the most recent 32 events (oldest → newest). */
  recent_events: StatusEvent[];
}

export const EVENT_DISPLAY_WINDOW_MS = 10_000;
export const EVENT_RING_LIMIT = 32;

export function emptyEventCounters(): StatusEventCounters {
  return {
    aligned: 0,
    created: 0,
    supplemented: 0,
    constrained: 0,
    refreshed: 0,
    conflicts_pending: 0,
    drift_pending: 0,
  };
}

export {
  defaultStatusJson,
  statusJsonPath,
  writeStatusJson,
} from "./writer.js";
export {
  readStatusForCLI,
  readAdoptionState,
  type AdoptionState,
} from "./reader.js";
export {
  formatStatus,
  renderCtxMeter,
  renderMissionSegment,
  type CtxMeterInput,
  type MissionCursorInput,
} from "./format.js";
export {
  pushEvent,
  bumpCounter,
  setHaikuAvailable,
  expireDisplayWindow,
} from "./event-queue.js";
