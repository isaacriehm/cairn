/**
 * Invalidation event reader + retention GC.
 *
 * `eventsSince(repoRoot, sinceMs)` — list events with ts > sinceMs,
 * sorted ascending. Used by the plugin Stop hook to surface only events
 * that landed during the current session.
 *
 * `gcStaleEvents(repoRoot, opts?)` — drops events older than 7 days.
 * Wired into the standard sweep so the events directory stays bounded.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./paths.js";
import type { InvalidationEvent, InvalidationEventRef } from "./writer.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface EventsSinceArgs {
  repoRoot: string;
  /** Lower bound — only events with `ts > sinceMs` are returned. */
  sinceMs: number;
  /** Optional cap on results; sorted ascending so a cap drops the tail. */
  limit?: number;
}

export interface EventsSinceResult {
  events: InvalidationEvent[];
  /** Files we tried to read but couldn't parse — surfaced for telemetry. */
  malformed: string[];
}

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
    if (!isInvalidationEvent(parsed)) {
      malformed.push(e.name);
      continue;
    }
    if (parsed.ts > args.sinceMs) events.push(parsed);
  }

  events.sort((a, b) => a.ts - b.ts);
  if (typeof args.limit === "number" && events.length > args.limit) {
    events.length = args.limit;
  }
  return { events, malformed };
}

export interface GcStaleEventsArgs {
  repoRoot: string;
  /** Default 7 days. */
  maxAgeMs?: number;
  /** Override Date.now() — tests use this. */
  now?: () => number;
}

export interface GcStaleEventsResult {
  removed: string[];
  kept: string[];
}

/**
 * Remove event files older than `maxAgeMs` (default 7 days). Uses each
 * file's parsed `ts` when present; falls back to `mtimeMs` otherwise.
 */
export function gcStaleEvents(args: GcStaleEventsArgs): GcStaleEventsResult {
  const dir = eventsDir(args.repoRoot);
  const removed: string[] = [];
  const kept: string[] = [];
  if (!existsSync(dir)) return { removed, kept };

  const maxAge = args.maxAgeMs ?? SEVEN_DAYS_MS;
  const now = args.now ? args.now() : Date.now();
  const entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const abs = join(dir, e.name);
    let ts: number | null = null;
    try {
      const parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<InvalidationEvent>;
      if (typeof parsed?.ts === "number") ts = parsed.ts;
    } catch {
      ts = null;
    }
    if (ts === null) {
      try {
        ts = statSync(abs).mtimeMs;
      } catch {
        ts = 0;
      }
    }
    if (now - ts >= maxAge) {
      try {
        rmSync(abs, { force: true });
        removed.push(e.name);
      } catch {
        kept.push(e.name);
      }
    } else {
      kept.push(e.name);
    }
  }
  return { removed, kept };
}

function isInvalidationEvent(x: unknown): x is InvalidationEvent {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o["ts"] !== "number") return false;
  if (typeof o["kind"] !== "string") return false;
  if (!Array.isArray(o["refs"])) return false;
  for (const r of o["refs"]) if (!isRef(r)) return false;
  const source = o["source"];
  if (source === null || typeof source !== "object") return false;
  const s = source as Record<string, unknown>;
  if (s["session_id"] !== null && typeof s["session_id"] !== "string") return false;
  if (typeof s["tool"] !== "string") return false;
  if (o["path"] !== undefined && typeof o["path"] !== "string") return false;
  return true;
}

function isRef(x: unknown): x is InvalidationEventRef {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    (o["kind"] === "decision" ||
      o["kind"] === "invariant" ||
      o["kind"] === "task" ||
      o["kind"] === "path")
  );
}
