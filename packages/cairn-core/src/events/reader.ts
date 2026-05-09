/**
 * Invalidation event reader + retention GC.
 *
 * `eventsSince(repoRoot, sinceMs)` — list events with ts > sinceMs,
 * sorted ascending. Used by the plugin Stop hook to surface only events
 * that landed during the current session.
 *
 * `gcStaleEvents(repoRoot)` — prune events older than 7 days.
 * Wired into the standard sweep so the events directory stays lean.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { eventsDir } from "./paths.js";
import type { InvalidationEvent } from "./writer.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const InvalidationEventRefSchema = z.object({
  kind: z.enum(["decision", "invariant", "task", "path"]),
  id: z.string(),
});

const InvalidationEventSchema = z.object({
  ts: z.number(),
  kind: z.string(),
  refs: z.array(InvalidationEventRefSchema),
  path: z.string().optional(),
  source: z.object({
    session_id: z.string().nullable(),
    tool: z.string(),
  }),
});

export interface EventsSinceArgs {
  repoRoot: string;
  /** Lower bound — only events with `ts > sinceMs` are returned. */
  sinceMs: number;
  /** Optional cap on results; sorted ascending so a cap drops the tail. */
  limit?: number;
}

export interface EventsSinceResult {
  events: InvalidationEvent[];
  /** File names that failed to parse (corruption or stale schema). */
  malformed: string[];
}

/**
 * Scan for all event JSON files in the ground and return those newer
 * than `sinceMs`.
 */
export function eventsSince(args: EventsSinceArgs): EventsSinceResult {
  const dir = eventsDir(args.repoRoot);
  const events: InvalidationEvent[] = [];
  const malformed: string[] = [];
  if (!existsSync(dir)) return { events, malformed };

  const entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const abs = join(dir, e.name);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      malformed.push(e.name);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      malformed.push(e.name);
      continue;
    }
    const result = InvalidationEventSchema.safeParse(parsed);
    if (!result.success) {
      malformed.push(e.name);
      continue;
    }
    const event = result.data as InvalidationEvent;
    if (event.ts > args.sinceMs) events.push(event);
  }

  events.sort((a, b) => a.ts - b.ts);
  if (typeof args.limit === "number" && events.length > args.limit) {
    events.length = args.limit;
  }
  return { events, malformed };
}

export interface GcStaleEventsArgs {
  repoRoot: string;
}

export interface GcStaleEventsResult {
  removed: string[];
  kept: number;
}

/**
 * Delete event JSONs with `ts < (now - 7 days)`.
 */
export function gcStaleEvents(args: GcStaleEventsArgs): GcStaleEventsResult {
  const dir = eventsDir(args.repoRoot);
  if (!existsSync(dir)) return { removed: [], kept: 0 };
  const entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const removed: string[] = [];
  let kept = 0;

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const abs = join(dir, e.name);
    let ts: number | null = null;
    try {
      const raw = readFileSync(abs, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = InvalidationEventSchema.partial().safeParse(parsed);
      if (result.success && result.data.ts !== undefined) {
        ts = result.data.ts;
      }
    } catch {
      ts = null;
    }
    if (ts === null) {
      try {
        unlinkSync(abs);
        removed.push(e.name);
      } catch {
        /* ignore */
      }
      continue;
    }

    if (ts < cutoff) {
      try {
        unlinkSync(abs);
        removed.push(e.name);
      } catch {
        /* ignore */
      }
    } else {
      kept += 1;
    }
  }
  return { removed, kept };
}
