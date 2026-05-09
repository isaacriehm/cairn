/**
 * Invalidation event writer.
 *
 * Per PLUGIN_ARCHITECTURE §7 (three-layer conflict catch, layer 2),
 * every locked write to global state emits a small JSON file under
 * `.cairn/events/`. Plugin Stop hooks in other live sessions poll
 * that directory and surface an inline A/B/C if the event touches a
 * DEC/§INV they have in scope.
 *
 * Files: `.cairn/events/<msTs>-<kind>.json` — sortable by name. ts
 * collisions resolved with a short crypto suffix.
 *
 * Retention: events older than 7 days are GC'd by `gcStaleEvents`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { eventsDir } from "./paths.js";

/**
 * Reference into the canonical zone — what this event invalidates.
 * Decision/invariant ids are filtered against the reading session's
 * in-scope set; path entries match against scope-globs.
 */
export interface InvalidationEventRef {
  kind: "decision" | "invariant" | "task" | "path";
  id: string;
}

export interface InvalidationEventSource {
  /** Claude Code session id of the writer, if known. */
  session_id: string | null;
  /** MCP tool name (e.g. `cairn_record_decision`) or other emitter id. */
  tool: string;
}

export interface InvalidationEvent {
  /** ms-since-epoch — set by the writer if not provided. */
  ts: number;
  /** Short event kind. Decision-recorded, archived, task-created, etc. */
  kind: string;
  /** Things this event invalidates. Empty array allowed for diagnostic events. */
  refs: InvalidationEventRef[];
  /** Path relative to repo root, when applicable. */
  path?: string;
  /** Where the event came from. */
  source: InvalidationEventSource;
}

export interface WriteInvalidationEventInput {
  kind: string;
  refs: InvalidationEventRef[];
  source: InvalidationEventSource;
  path?: string;
  /** Override Date.now() — tests use this. */
  ts?: number;
}

export interface WriteInvalidationEventResult {
  /** Absolute path to the event file written. */
  filePath: string;
  /** Final event payload (with ts filled in). */
  event: InvalidationEvent;
}

/**
 * Write a single invalidation event. Best-effort — failures throw, but
 * locked-write callers should swallow + log so the underlying write is
 * never rolled back by an emit failure.
 */
export function writeInvalidationEvent(
  repoRoot: string,
  input: WriteInvalidationEventInput,
): WriteInvalidationEventResult {
  const ts = input.ts ?? Date.now();
  const event: InvalidationEvent = {
    ts,
    kind: input.kind,
    refs: input.refs,
    source: input.source,
    ...(input.path !== undefined ? { path: input.path } : {}),
  };

  const dir = eventsDir(repoRoot);
  mkdirSync(dir, { recursive: true });

  // Filename: `<14-digit-ts>-<kind>.json`. ms epoch is ~13 digits today;
  // pad to 14 so files sort lexically by ts even past year 2286. On
  // collision append a short random suffix.
  const tsStr = String(ts).padStart(14, "0");
  const safeKind = sanitizeKind(input.kind);
  let filename = `${tsStr}-${safeKind}.json`;
  let filePath = join(dir, filename);
  // wx + retry on EEXIST; bound the retries to a tiny number — Date.now()
  // collisions across writers within the same ms are vanishingly rare,
  // and the random suffix breaks ties in O(1) attempts.
  let attempts = 0;
  while (true) {
    try {
      writeFileSync(filePath, `${JSON.stringify(event, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { filePath, event };
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as { code: string }).code : null;
      if (code !== "EEXIST" || attempts >= 4) throw err;
      const suffix = randomBytes(2).toString("hex");
      filename = `${tsStr}-${safeKind}-${suffix}.json`;
      filePath = join(dir, filename);
      attempts += 1;
    }
  }
}

function sanitizeKind(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "event";
}
