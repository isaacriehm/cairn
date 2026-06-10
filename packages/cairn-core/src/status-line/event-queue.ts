import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionStateDir } from "../paths/index.js";
import {
  EVENT_DISPLAY_WINDOW_MS,
  EVENT_RING_LIMIT,
  emptyEventCounters,
  type StatusEvent,
  type StatusEventCounters,
  type StatusEventKind,
  type StatusJson,
} from "./index.js";
import { defaultStatusJson, statusJsonPath } from "./writer.js";
import { cairnDir } from "@isaacriehm/cairn-state";

/**
 * Status-line event queue (plan §9).
 *
 * Layer A (alignment hook), SessionStart Drain (SessionStart drain), and the doc-drift
 * sensor all push events here. The status-line reader honors
 * `current_event.display_until` to keep a blip visible for 10s before
 * rolling back to the session summary counter.
 *
 * The "ring buffer" is persisted on disk inside status.json so successive
 * hook invocations (each its own subprocess) see consistent history.
 * Counters increment on every push regardless of buffer overflow — they
 * never decrease and survive arbitrary restarts.
 */

const COUNTER_KIND: Record<StatusEventKind, keyof StatusEventCounters | null> = {
  aligned: "aligned",
  "created-dec": "created",
  "created-inv": "created",
  supplemented: "supplemented",
  constrained: "constrained",
  refreshed: "refreshed",
  scanning: null,
  "drain-progress": null,
  "drain-done": null,
  "haiku-offline": null,
};

function readStatusJsonRaw(repoRoot: string, sessionId: string): StatusJson {
  const path = statusJsonPath(repoRoot, sessionId);
  if (!existsSync(path)) return defaultStatusJson();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StatusJson>;
    if (parsed === null || typeof parsed !== "object") return defaultStatusJson();
    return mergeWithDefaults(parsed);
  } catch {
    return defaultStatusJson();
  }
}

function mergeWithDefaults(partial: Partial<StatusJson>): StatusJson {
  const base = defaultStatusJson();
  return {
    ...base,
    ...partial,
    event_counters: { ...base.event_counters, ...(partial.event_counters ?? {}) },
    recent_events: partial.recent_events ?? base.recent_events,
    current_event: partial.current_event ?? base.current_event,
    haiku_unavailable: partial.haiku_unavailable ?? base.haiku_unavailable,
  };
}

function writeAtomic(repoRoot: string, sessionId: string, status: StatusJson): void {
  if (!existsSync(cairnDir(repoRoot))) return;
  const stateDir = sessionStateDir(repoRoot, sessionId);
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "status.json");
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

interface PushEventInput {
  kind: StatusEventKind;
  primary_id?: string;
  secondary_id?: string;
  detail?: string;
  /** Override the display window (ms). Defaults to 10s sticky. */
  window_ms?: number;
}

/**
 * Append an event to the ring buffer, increment the matching counter,
 * and set it as the active display blip for the next 10s.
 *
 * Returns the resulting StatusJson (mostly useful for tests; production
 * callers ignore the return).
 */
export function pushEvent(
  repoRoot: string,
  sessionId: string,
  input: PushEventInput,
): StatusJson {
  const status = readStatusJsonRaw(repoRoot, sessionId);
  const now = Date.now();
  const window = input.window_ms ?? EVENT_DISPLAY_WINDOW_MS;
  const event: StatusEvent = {
    ts: now,
    kind: input.kind,
    display_until: now + window,
  };
  if (input.primary_id !== undefined) event.primary_id = input.primary_id;
  if (input.secondary_id !== undefined) event.secondary_id = input.secondary_id;
  if (input.detail !== undefined) event.detail = input.detail;

  const ring = [...status.recent_events, event];
  if (ring.length > EVENT_RING_LIMIT) ring.splice(0, ring.length - EVENT_RING_LIMIT);

  const counterKey = COUNTER_KIND[input.kind];
  const counters = { ...status.event_counters };
  if (counterKey !== null) counters[counterKey] += 1;

  const next: StatusJson = {
    ...status,
    updated_at: new Date().toISOString(),
    current_event: event,
    event_counters: counters,
    recent_events: ring,
  };
  writeAtomic(repoRoot, sessionId, next);
  return next;
}

/**
 * Increment a counter without emitting a visible blip. Used by sensors
 * that want to bump `conflicts_pending` or `drift_pending` for the
 * summary fallback without preempting the display window.
 */
export function bumpCounter(
  repoRoot: string,
  sessionId: string,
  key: keyof StatusEventCounters,
  delta: number,
): StatusJson {
  const status = readStatusJsonRaw(repoRoot, sessionId);
  const counters = { ...status.event_counters };
  counters[key] = Math.max(0, counters[key] + delta);
  const next: StatusJson = {
    ...status,
    updated_at: new Date().toISOString(),
    event_counters: counters,
  };
  writeAtomic(repoRoot, sessionId, next);
  return next;
}

export function setHaikuAvailable(
  repoRoot: string,
  sessionId: string,
  available: boolean,
): StatusJson {
  const status = readStatusJsonRaw(repoRoot, sessionId);
  if (status.haiku_unavailable === !available) {
    return status;
  }
  const next: StatusJson = {
    ...status,
    updated_at: new Date().toISOString(),
    haiku_unavailable: !available,
  };
  if (!available) {
    const event: StatusEvent = {
      ts: Date.now(),
      kind: "haiku-offline",
      display_until: Date.now() + EVENT_DISPLAY_WINDOW_MS,
    };
    next.current_event = event;
    next.recent_events = [...status.recent_events, event].slice(-EVENT_RING_LIMIT);
  }
  writeAtomic(repoRoot, sessionId, next);
  return next;
}

/**
 * Idempotently clear `current_event` once its display window has expired.
 * The reader can use this to fall back to the summary counter without
 * mutating state on a hot path; callers that mutate (e.g. cairn-attention
 * SessionStart drain) call this before re-rendering.
 */
export function expireDisplayWindow(
  repoRoot: string,
  sessionId: string,
  nowMs: number = Date.now(),
): StatusJson {
  const status = readStatusJsonRaw(repoRoot, sessionId);
  if (status.current_event === null) return status;
  if (status.current_event.display_until > nowMs) return status;
  const next: StatusJson = {
    ...status,
    updated_at: new Date().toISOString(),
    current_event: null,
  };
  writeAtomic(repoRoot, sessionId, next);
  return next;
}

/**
 * Compute what the next blip *would* render without mutating disk.
 * Used by the reader when status.json's `current_event` is past its
 * display window — we want the rolling summary to show up rather than
 * a stale "aligned · DEC-…" line.
 */
export function activeEvent(
  status: StatusJson,
  nowMs: number = Date.now(),
): StatusEvent | null {
  const ev = status.current_event;
  if (ev === null || ev === undefined) return null;
  if (ev.display_until <= nowMs) return null;
  return ev;
}

export function summaryCounterText(counters: StatusEventCounters | undefined): string | null {
  if (!counters) return null;
  const parts: string[] = [];
  if ((counters.aligned ?? 0) > 0) parts.push(`${counters.aligned} aligned`);
  if ((counters.created ?? 0) > 0) parts.push(`${counters.created} created`);
  if ((counters.supplemented ?? 0) > 0) parts.push(`${counters.supplemented} supplemented`);
  if ((counters.constrained ?? 0) > 0) parts.push(`${counters.constrained} constrained`);
  if ((counters.refreshed ?? 0) > 0) parts.push(`${counters.refreshed} refreshed`);
  if (parts.length === 0) return null;
  return `⚑ ${parts.join(" · ")}`;
}
