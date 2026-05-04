/**
 * Invalidation events — `.harness/events/<msTs>-<kind>.json`.
 *
 * Locked write tools emit events after their write completes. Plugin
 * Stop hooks in other live sessions poll this directory and surface an
 * inline A/B/C if an event touches a DEC/§V/path the reader has in
 * scope. 7-day retention via `gcStaleEvents`.
 *
 * Spec: PLUGIN_ARCHITECTURE §7 (three-layer conflict catch, layer 2).
 */

export { eventsDir } from "./paths.js";
export { writeInvalidationEvent } from "./writer.js";
export type {
  InvalidationEvent,
  InvalidationEventRef,
  InvalidationEventSource,
  WriteInvalidationEventInput,
  WriteInvalidationEventResult,
} from "./writer.js";
export { eventsSince, gcStaleEvents } from "./reader.js";
export type {
  EventsSinceArgs,
  EventsSinceResult,
  GcStaleEventsArgs,
  GcStaleEventsResult,
} from "./reader.js";
