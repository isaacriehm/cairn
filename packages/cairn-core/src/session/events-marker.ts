/**
 * Per-session events marker — `.harness/sessions/<id>/events-marker.json`.
 *
 * Records the timestamp at which a session armed its events watch. The
 * Stop hook (step 4) reads `eventsSince(repoRoot, marker.ts)` and
 * surfaces only events that landed after this session started.
 *
 * Spec: PLUGIN_ARCHITECTURE §7 (invalidation events).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionStateDir } from "../paths/index.js";

export interface EventsMarker {
  /** ms epoch at which the session armed its events watch. */
  ts: number;
  /** ms epoch of the last poll the Stop hook performed. Defaults to ts. */
  last_polled_ts: number;
}

const MARKER_FILE = "events-marker.json";

/** Absolute path to the marker file for `sessionId`. */
export function eventsMarkerPath(repoRoot: string, sessionId: string): string {
  return join(sessionStateDir(repoRoot, sessionId), MARKER_FILE);
}

/**
 * Seed the marker at session start. If a marker already exists (e.g.
 * the SessionStart hook ran twice), the existing marker is preserved
 * and returned unchanged.
 */
export function seedEventsMarker(args: {
  repoRoot: string;
  sessionId: string;
  ts?: number;
}): EventsMarker {
  const dir = sessionStateDir(args.repoRoot, args.sessionId);
  const path = join(dir, MARKER_FILE);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EventsMarker>;
      if (typeof parsed?.ts === "number") {
        const last = typeof parsed.last_polled_ts === "number" ? parsed.last_polled_ts : parsed.ts;
        return { ts: parsed.ts, last_polled_ts: last };
      }
    } catch {
      // fall through and overwrite
    }
  }
  const ts = args.ts ?? Date.now();
  const marker: EventsMarker = { ts, last_polled_ts: ts };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

/** Read the marker. Returns null when absent or malformed. */
export function readEventsMarker(repoRoot: string, sessionId: string): EventsMarker | null {
  const path = eventsMarkerPath(repoRoot, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EventsMarker>;
    if (typeof parsed?.ts !== "number") return null;
    const last = typeof parsed.last_polled_ts === "number" ? parsed.last_polled_ts : parsed.ts;
    return { ts: parsed.ts, last_polled_ts: last };
  } catch {
    return null;
  }
}

/**
 * Stamp the marker's `last_polled_ts`. Called by the Stop hook after
 * draining events so the next poll only sees newer ones. Safe to call
 * before the marker exists — falls through and seeds.
 */
export function stampEventsPoll(args: {
  repoRoot: string;
  sessionId: string;
  ts: number;
}): EventsMarker {
  const existing = readEventsMarker(args.repoRoot, args.sessionId);
  const baseTs = existing?.ts ?? args.ts;
  const marker: EventsMarker = { ts: baseTs, last_polled_ts: args.ts };
  const dir = sessionStateDir(args.repoRoot, args.sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(eventsMarkerPath(args.repoRoot, args.sessionId), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}
