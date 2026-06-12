/**
 * Per-session state lifecycle.
 *
 * Owns `.cairn/sessions/<id>/` — the directory each Claude Code
 * session uses for its own status.json, current task pointer, and run
 * notes. Spec: PLUGIN_ARCHITECTURE §7.
 *
 * SessionStart hook calls `ensureSessionDir` + `gcStaleSessions`.
 * SessionEnd hook calls `cleanupSession`.
 */

export {
  cleanupSession,
  ensureSessionDir,
  gcStaleSessions,
  resolveSessionId,
} from "./id.js";
export type {
  EnsureSessionDirArgs,
  EnsureSessionDirResult,
  GcStaleSessionsArgs,
  GcStaleSessionsResult,
  SessionIdSource,
  SessionMeta,
} from "./id.js";
export {
  eventsMarkerPath,
  readEventsMarker,
  seedEventsMarker,
  stampEventsPoll,
} from "./events-marker.js";
export type { EventsMarker } from "./events-marker.js";
export {
  fingerprintText,
  filterUnshownIds,
  getSeenFingerprint,
  hasShownId,
  markShownIds,
  setSeenFingerprint,
} from "./seen.js";
