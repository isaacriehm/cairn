/**
 * Per-run structured log — `.harness/runs/active/<run_id>/log.jsonl`.
 *
 * Sibling to `events.jsonl`. Where events.jsonl is the raw claude
 * stream-json firehose, log.jsonl is the orchestrator-curated narrative:
 * one entry per meaningful state transition (run started, phase changed,
 * sensor result, reviewer verdict, UAT decision, run completed, error).
 *
 * Operator-facing surfacing (per §3.3 win 1): the live status embed tails
 * the last N entries into the description so the operator sees ACTUAL
 * progress instead of a static "phase: running" line.
 *
 * Append-only, best-effort. Failures log a warn but never throw to the
 * caller — log emission is observability, not control flow.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";
import {
  extractToolDigest,
  type ToolDigest,
} from "./tool-digest.js";

const log = logger("orchestrator.run-log");

const RUNS_ACTIVE_REL = ".harness/runs/active";

export type RunLogKind =
  | "run_started"
  | "tightener_done"
  | "tightener_q_answered"
  | "tightener_q_timeout"
  | "phase_changed"
  | "attempt_started"
  | "sensor_sweep"
  | "reviewer_verdict"
  | "uat_decision"
  | "backprop_done"
  | "run_completed"
  | "halt_requested"
  | "watchdog_stall"
  | "error";

export interface RunLogEntry {
  ts: string;
  run_id: string;
  task_id?: string;
  kind: RunLogKind;
  /** Short human-formatted summary (≤120 chars) for embed tail rendering. */
  summary: string;
  /** Free-form payload — kind-specific fields. */
  data?: Record<string, unknown>;
}

export interface AppendRunLogArgs {
  repoRoot: string;
  runId: string;
  taskId?: string;
  kind: RunLogKind;
  summary: string;
  data?: Record<string, unknown>;
}

export function runLogPath(repoRoot: string, runId: string): string {
  return join(repoRoot, RUNS_ACTIVE_REL, runId, "log.jsonl");
}

export async function appendRunLogEntry(args: AppendRunLogArgs): Promise<void> {
  const path = runLogPath(args.repoRoot, args.runId);
  const entry: RunLogEntry = {
    ts: new Date().toISOString(),
    run_id: args.runId,
    ...(args.taskId !== undefined ? { task_id: args.taskId } : {}),
    kind: args.kind,
    summary: args.summary.slice(0, 200),
    ...(args.data !== undefined ? { data: args.data } : {}),
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    log.warn(
      { err: String(err), run_id: args.runId, kind: args.kind },
      "run-log append failed",
    );
  }
}

/**
 * Read the last `n` entries from the run's log.jsonl. Returns oldest →
 * newest. Best-effort: missing file returns empty; parse errors skip.
 */
export async function readRunLogTail(args: {
  repoRoot: string;
  runId: string;
  n: number;
}): Promise<RunLogEntry[]> {
  const path = runLogPath(args.repoRoot, args.runId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((s) => s.length > 0);
  const tail = lines.slice(Math.max(0, lines.length - args.n));
  const out: RunLogEntry[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as RunLogEntry;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.ts === "string" &&
        typeof parsed.kind === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Format a tail of run-log entries for the live status embed description.
 * Each line: `HH:MM:SS · KIND · summary` — 80 char hard cap per line.
 */
export function formatRunLogTail(entries: readonly RunLogEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    const t = e.ts.slice(11, 19);
    const kind = e.kind.replace(/_/g, " ");
    const summary = e.summary.slice(0, 80 - t.length - kind.length - 6);
    lines.push(`\`${t}\` · **${kind}** · ${summary}`);
  }
  return lines.join("\n");
}

export type { ToolDigest };
export { extractToolDigest };
