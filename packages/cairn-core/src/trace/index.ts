/**
 * Unified trace log for live-session debugging.
 *
 * Every cairn surface (Claude Code hooks, MCP tools, `claude --print`
 * subprocess calls, init phases) appends a single jsonl row per event
 * to `~/.cairn/trace/trace-<YYYY-MM-DD>.jsonl`. The `cairn trace`
 * CLI subcommand reads them back time-sorted across the most recent
 * day(s) so the operator can post-mortem an entire live session in one
 * pane.
 *
 * Best-effort: trace failures NEVER throw — debug logging that breaks
 * the surface it's monitoring is worse than no logging.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { userCairnRoot } from "../paths/index.js";

export type TraceSource = "hook" | "mcp" | "claude" | "init-phase" | "subagent";

export interface TraceEvent {
  /** ISO 8601 with millisecond precision. */
  ts: string;
  /** Top-level surface emitting the event. */
  source: TraceSource;
  /** Event-specific kind ("session-start", "tool-call", "claude-request", …). */
  kind: string;
  /** Adopted-repo root, when known. */
  repo_root: string | null;
  /** Claude Code session id, when known. */
  session_id: string | null;
  /** Wall time spent, when applicable. */
  duration_ms?: number;
  /** Success / failure outcome, when applicable. */
  ok?: boolean;
  /** Free-form payload — keep small; large bodies should be stored separately. */
  payload: Record<string, unknown>;
}

export function traceDir(): string {
  return join(userCairnRoot(), "trace");
}

function todayFilename(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `trace-${y}-${m}-${d}.jsonl`;
}

export function traceFilePath(now: Date = new Date()): string {
  return join(traceDir(), todayFilename(now));
}

/**
 * Append one trace row. Best-effort — swallows any IO error so callers
 * never break their primary surface on trace-write failure.
 */
export function appendTrace(event: TraceEvent): void {
  try {
    const dir = traceDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(traceFilePath(), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Build a TraceEvent with `ts` set to now. Convenience for callsites
 * that build the rest of the row inline.
 */
export function nowEvent(args: Omit<TraceEvent, "ts">): TraceEvent {
  return { ts: new Date().toISOString(), ...args };
}
