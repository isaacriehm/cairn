/**
 * Task lifecycle helpers — the only sanctioned writers of `status.yaml`
 * phase transitions and the only path that moves a task directory from
 * `tasks/active/` to `tasks/done/`.
 *
 * Two surfaces:
 *   - `completeTask`        — terminal phase + dir move; emits invalidation.
 *   - `transitionTaskPhase` — in-place phase write (e.g. running →
 *                              ready_for_review); no dir move.
 *
 * Plus a read helper `readTaskAttestationState` used by the Stop hook
 * auto-graduator to decide which transition (if any) to apply.
 *
 * Tasks created by `cairn_task_create` start at `phase: running`.
 * The reviewer subagent calls `completeTask` after writing
 * `attestation.yaml`; the Stop hook auto-graduator handles the cases
 * where the reviewer is skipped (trivial tasks with
 * `needs_review: false`).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeInvalidationEvent } from "../events/index.js";
import { onTaskCompleted } from "../missions/task-link.js";

export type TaskOutcome = "succeeded" | "failed" | "aborted";
export type TaskTransitionPhase =
  | "queued"
  | "tightening"
  | "running"
  | "sensor_check"
  | "ready_for_review"
  | "awaiting_attestation"
  | "reviewing"
  | "backprop";

interface StatusYaml {
  id?: string;
  phase?: string;
  module?: string;
  title?: string;
  started_at?: string;
  completed_at?: string;
  outcome_summary?: string;
  related_run_ids?: string[];
  [key: string]: unknown;
}

export interface CompleteTaskArgs {
  repoRoot: string;
  taskId: string;
  outcome: TaskOutcome;
  summary?: string;
  /**
   * What invoked this completion — written into the invalidation event
   * `source.tool` field. Defaults to `cairn_task_complete`; the Stop
   * hook auto-graduator passes `cairn_stop_auto_graduate` so the audit
   * log distinguishes the two paths.
   */
  source?: string;
}

export interface CompleteTaskResult {
  ok: true;
  taskId: string;
  outcome: TaskOutcome;
  completedAt: string;
  movedTo: string;
}

export interface CompleteTaskError {
  ok: false;
  code: "TASK_NOT_FOUND" | "ALREADY_COMPLETED" | "DONE_DIR_COLLISION";
  message: string;
}

/**
 * Write the terminal phase + move the active dir → done. Returns an
 * error envelope on failure rather than throwing — callers (MCP tool,
 * Stop hook) decide how to surface.
 */
export function completeTask(
  args: CompleteTaskArgs,
): CompleteTaskResult | CompleteTaskError {
  const activeDir = join(args.repoRoot, ".cairn", "tasks", "active", args.taskId);
  const doneRoot = join(args.repoRoot, ".cairn", "tasks", "done");
  const doneDir = join(doneRoot, args.taskId);

  if (!existsSync(activeDir)) {
    if (existsSync(doneDir)) {
      return {
        ok: false,
        code: "ALREADY_COMPLETED",
        message: `Task ${args.taskId} already in tasks/done/`,
      };
    }
    return {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `No active task ${args.taskId}`,
    };
  }

  if (existsSync(doneDir)) {
    return {
      ok: false,
      code: "DONE_DIR_COLLISION",
      message: `tasks/done/${args.taskId} already exists; refusing to overwrite. Investigate stale prior completion.`,
    };
  }

  const statusPath = join(activeDir, "status.yaml");
  const status = readStatusYaml(statusPath);
  const completedAt = new Date().toISOString();
  status.id = status.id ?? args.taskId;
  status.phase = args.outcome;
  status.completed_at = completedAt;
  if (args.summary !== undefined && args.summary.length > 0) {
    status.outcome_summary = args.summary;
  }
  writeFileSync(statusPath, stringifyYaml(status), "utf8");

  mkdirSync(doneRoot, { recursive: true });
  renameSync(activeDir, doneDir);

  try {
    writeInvalidationEvent(args.repoRoot, {
      kind: "task-completed",
      refs: [{ kind: "task", id: args.taskId }],
      source: { session_id: null, tool: args.source ?? "cairn_task_complete" },
    });
  } catch {
    // best-effort emission — completion already landed on disk
  }

  // Mission linkage — append the task id to its phase's task_ids,
  // emit phase-ready-to-exit when last task graduated under
  // gate=prompt, advance cursor under gate=auto. Best-effort; never
  // block graduation.
  try {
    onTaskCompleted(args.repoRoot, args.taskId, args.outcome);
  } catch {
    // best-effort
  }

  return {
    ok: true,
    taskId: args.taskId,
    outcome: args.outcome,
    completedAt,
    movedTo: `.cairn/tasks/done/${args.taskId}/`,
  };
}

export interface TransitionTaskPhaseArgs {
  repoRoot: string;
  taskId: string;
  newPhase: TaskTransitionPhase;
}

export function transitionTaskPhase(args: TransitionTaskPhaseArgs): boolean {
  const activeDir = join(args.repoRoot, ".cairn", "tasks", "active", args.taskId);
  if (!existsSync(activeDir)) return false;
  const statusPath = join(activeDir, "status.yaml");
  if (!existsSync(statusPath)) return false;
  const status = readStatusYaml(statusPath);
  status.phase = args.newPhase;
  writeFileSync(statusPath, stringifyYaml(status), "utf8");
  return true;
}

export interface TaskAttestationState {
  rootAttestation: boolean;
  subagentAttestations: number;
  needsReview: boolean;
  phase: string | null;
}

/**
 * Read the attestation + needs_review state for an active task. Used
 * by the Stop hook auto-graduator to decide which phase transition (if
 * any) to apply.
 */
export function readTaskAttestationState(
  repoRoot: string,
  taskId: string,
): TaskAttestationState | null {
  const taskDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  if (!existsSync(taskDir)) return null;

  const rootAttestation = existsSync(join(taskDir, "attestation.yaml"));

  let subagentAttestations = 0;
  const subagentsDir = join(taskDir, "subagents");
  if (existsSync(subagentsDir)) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(subagentsDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (existsSync(join(subagentsDir, e.name, "attestation.yaml"))) {
        subagentAttestations += 1;
      }
    }
  }

  const needsReview = readNeedsReview(join(taskDir, "spec.tightened.md"));
  const phase = readPhase(join(taskDir, "status.yaml"));

  return {
    rootAttestation,
    subagentAttestations,
    needsReview,
    phase,
  };
}

/* -------------------------------------------------------------------------- */
/* Task journal — Cairn-as-resume-layer                                        */
/* -------------------------------------------------------------------------- */

export interface JournalEntry {
  ts: string;
  session_id: string | null;
  summary: string;
  next_step?: string;
  files_touched?: string[];
  decisions_loaded?: string[];
}

export interface AppendJournalArgs {
  repoRoot: string;
  taskId: string;
  sessionId: string | null;
  summary: string;
  nextStep?: string;
  filesTouched?: string[];
  decisionsLoaded?: string[];
}

/**
 * Append a single journal entry to
 * `.cairn/tasks/active/<task_id>/journal.jsonl`. The journal is the
 * authoritative record of what happened during a task across multiple
 * Claude Code sessions. The resume command reads it after `/clear`
 * to rebuild the operator's mental state.
 *
 * Returns false when the task directory is missing — caller decides
 * how to surface (typically a no-op since journal append is best-effort
 * inside the Stop hook).
 */
export function appendTaskJournal(args: AppendJournalArgs): boolean {
  const taskDir = join(
    args.repoRoot,
    ".cairn",
    "tasks",
    "active",
    args.taskId,
  );
  if (!existsSync(taskDir)) return false;
  const entry: JournalEntry = {
    ts: new Date().toISOString(),
    session_id: args.sessionId,
    summary: args.summary,
  };
  if (args.nextStep !== undefined && args.nextStep.length > 0) {
    entry.next_step = args.nextStep;
  }
  if (args.filesTouched !== undefined && args.filesTouched.length > 0) {
    entry.files_touched = args.filesTouched;
  }
  if (args.decisionsLoaded !== undefined && args.decisionsLoaded.length > 0) {
    entry.decisions_loaded = args.decisionsLoaded;
  }
  const path = join(taskDir, "journal.jsonl");
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  return true;
}

export function readTaskJournal(
  repoRoot: string,
  taskId: string,
  scope: "active" | "done" = "active",
): JournalEntry[] {
  const taskDir = join(repoRoot, ".cairn", "tasks", scope, taskId);
  const path = join(taskDir, "journal.jsonl");
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.ts === "string" &&
        typeof parsed.summary === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Look up the single active task that should be the implicit target
 * for `cairn_task_journal_append` / `cairn_resume`. Picks the task
 * with the most-recently-modified `status.yaml` whose phase is in the
 * active set. Returns null when no active task exists.
 */
export function findCurrentActiveTask(repoRoot: string): string | null {
  const activeDir = join(repoRoot, ".cairn", "tasks", "active");
  if (!existsSync(activeDir)) return null;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return null;
  }
  const ACTIVE_PHASES = new Set([
    "queued",
    "tightening",
    "running",
    "sensor_check",
    "ready_for_review",
    "awaiting_attestation",
    "reviewing",
    "backprop",
  ]);
  let best: { taskId: string; mtimeMs: number } | null = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const taskDir = join(activeDir, e.name);
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) continue;
    const phase = readPhase(statusPath);
    if (phase === null || !ACTIVE_PHASES.has(phase)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(statusPath).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtimeMs > best.mtimeMs) {
      best = { taskId: e.name, mtimeMs };
    }
  }
  return best?.taskId ?? null;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

function readStatusYaml(statusPath: string): StatusYaml {
  if (!existsSync(statusPath)) return {};
  try {
    const raw = readFileSync(statusPath, "utf8");
    const parsed = parseYaml(raw);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as StatusYaml;
    }
  } catch {
    // fall through — caller will overwrite with a fresh frame
  }
  return {};
}

function readNeedsReview(specPath: string): boolean {
  if (!existsSync(specPath)) return true;
  let raw: string;
  try {
    raw = readFileSync(specPath, "utf8");
  } catch {
    return true;
  }
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\n---/);
  if (!fmMatch) return true;
  const fm = fmMatch[1] ?? "";
  const m = fm.match(/^needs_review:\s*(true|false)/m);
  if (m && m[1] === "false") return false;
  return true;
}

function readPhase(statusPath: string): string | null {
  if (!existsSync(statusPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(statusPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^phase:\s*(\S+)/);
    if (m && m[1] !== undefined) return m[1].replace(/['"]/g, "");
  }
  return null;
}
