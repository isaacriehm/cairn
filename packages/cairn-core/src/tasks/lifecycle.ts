/**
 * Task lifecycle helpers — the only sanctioned writers of `status.yaml`
 * phase transitions and the only path that moves a task directory from
 * `tasks/active/` to `tasks/done/`.
 *
 * `completeTask` is the terminal phase + dir move + invalidation emit.
 * `readTaskAttestationState` is a read helper used by the Stop hook
 * auto-graduator to decide whether to close a task whose attestation
 * landed without an explicit close call.
 *
 * Tasks created by `cairn_task_create` start at `phase: running`.
 * The AI calls `completeTask` (via `cairn_task_complete`) with a
 * summary — that summary is the attestation. The Stop hook
 * auto-graduator is a fallback for the rare case where an opt-in
 * reviewer subagent wrote `attestation.yaml` and ended its turn
 * before the explicit close call.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeInvalidationEvent } from "../events/index.js";
import { onTaskCompleted } from "../missions/task-link.js";

export type TaskOutcome = "succeeded" | "failed" | "aborted";

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

/**
 * Mission-linkage outcome surfaced to the caller of `completeTask`.
 * When the task graduated a phase under `exit_gate=prompt`, the
 * `kind: "phase-ready-to-exit"` variant carries the operator-facing
 * info (mission title, phase title, exit criteria) so the MCP tool
 * response can include a render instruction the model uses to
 * surface AskUserQuestion in the same turn. No hook handoff needed.
 *
 * Auto-graduator path (Stop hook) gets the same struct but writes it
 * to the pending file for UPS to inject on the next prompt — see
 * `phase-ready-surface.ts`.
 */
export interface PhaseReadyToExitInfo {
  mission_id: string;
  mission_title: string;
  phase_id: string;
  phase_title: string;
  exit_criteria: string;
}

export interface CompleteTaskResult {
  ok: true;
  taskId: string;
  outcome: TaskOutcome;
  completedAt: string;
  movedTo: string;
  /**
   * When non-null, the phase's exit gate is `prompt` and every linked
   * task has graduated. Caller should surface the operator-facing
   * AskUserQuestion. Null when the phase isn't ready, auto-advanced
   * silently, or the idempotency flag already suppressed re-emission.
   */
  phase_ready_to_exit: PhaseReadyToExitInfo | null;
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
  // block graduation. When the result is `phase-ready-to-exit` we
  // pass the enriched info through to the caller so the MCP tool
  // can render the operator-facing AskUserQuestion instruction in
  // the same turn (no hook handoff, no banner).
  let phaseReadyToExit: PhaseReadyToExitInfo | null = null;
  try {
    const link = onTaskCompleted(args.repoRoot, args.taskId, args.outcome);
    if (link.kind === "phase-ready-to-exit") {
      phaseReadyToExit = {
        mission_id: link.mission_id,
        mission_title: link.mission_title,
        phase_id: link.phase_id,
        phase_title: link.phase_title,
        exit_criteria: link.exit_criteria,
      };
    }
  } catch {
    // best-effort
  }

  return {
    ok: true,
    taskId: args.taskId,
    outcome: args.outcome,
    completedAt,
    movedTo: `.cairn/tasks/done/${args.taskId}/`,
    phase_ready_to_exit: phaseReadyToExit,
  };
}

export interface ReopenTaskArgs {
  repoRoot: string;
  taskId: string;
  /**
   * Optional reason for the reopen — recorded in the journal entry so
   * the next session sees why the task came back from `tasks/done/`.
   */
  reason?: string;
  /**
   * What invoked the reopen — written into the invalidation event
   * `source.tool` field. Defaults to `cairn_task_reopen`.
   */
  source?: string;
}

export interface ReopenTaskResult {
  ok: true;
  taskId: string;
  reopenedAt: string;
  movedTo: string;
}

export interface ReopenTaskError {
  ok: false;
  code: "TASK_NOT_FOUND" | "NOT_IN_DONE" | "ACTIVE_DIR_COLLISION";
  message: string;
}

/**
 * Move a graduated task from `tasks/done/<id>/` back to
 * `tasks/active/<id>/` and reset its phase to `running`. Inverse of
 * `completeTask`.
 *
 * Recovery tool for when `cairn_task_complete` without `task_id`
 * graduated the wrong task (a parallel-session task picked via
 * mtime-based active-task fallback).
 *
 * Side-effect: renames any pre-existing `attestation.yaml` to
 * `attestation.<completedAt>.yaml` so the Stop-hook auto-graduator
 * doesn't immediately re-close the task on the next tick. The history
 * stays on disk for audit; the live state is clean.
 */
export function reopenTask(
  args: ReopenTaskArgs,
): ReopenTaskResult | ReopenTaskError {
  const activeDir = join(args.repoRoot, ".cairn", "tasks", "active", args.taskId);
  const doneDir = join(args.repoRoot, ".cairn", "tasks", "done", args.taskId);

  if (!existsSync(doneDir)) {
    if (existsSync(activeDir)) {
      return {
        ok: false,
        code: "NOT_IN_DONE",
        message: `Task ${args.taskId} is already active`,
      };
    }
    return {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `No completed task ${args.taskId}`,
    };
  }

  if (existsSync(activeDir)) {
    return {
      ok: false,
      code: "ACTIVE_DIR_COLLISION",
      message: `tasks/active/${args.taskId} already exists; refusing to overwrite. Investigate stale state.`,
    };
  }

  // Move the directory back. Renaming the attestation is best-effort —
  // a missing attestation is fine (e.g. autonomous-flow graduation),
  // a rename failure would just leave the auto-graduator to re-close
  // the task, which is acceptable behaviour for an interrupted reopen.
  renameSync(doneDir, activeDir);

  const statusPath = join(activeDir, "status.yaml");
  const status = readStatusYaml(statusPath);
  const completedAt =
    typeof status.completed_at === "string" ? status.completed_at : null;
  status.phase = "running";
  delete status.completed_at;
  delete status.outcome_summary;
  writeFileSync(statusPath, stringifyYaml(status), "utf8");

  const attestationPath = join(activeDir, "attestation.yaml");
  if (existsSync(attestationPath)) {
    const stamp = (completedAt ?? new Date().toISOString()).replace(/[:.]/g, "-");
    try {
      renameSync(attestationPath, join(activeDir, `attestation.${stamp}.yaml`));
    } catch {
      /* best-effort */
    }
  }

  const reopenedAt = new Date().toISOString();
  try {
    appendTaskJournal({
      repoRoot: args.repoRoot,
      taskId: args.taskId,
      sessionId: null,
      summary: `Reopened from tasks/done/${args.reason !== undefined ? ` — ${args.reason}` : ""}`,
    });
  } catch {
    /* best-effort */
  }

  try {
    writeInvalidationEvent(args.repoRoot, {
      kind: "task-reopened",
      refs: [{ kind: "task", id: args.taskId }],
      source: { session_id: null, tool: args.source ?? "cairn_task_reopen" },
    });
  } catch {
    /* best-effort */
  }

  return {
    ok: true,
    taskId: args.taskId,
    reopenedAt,
    movedTo: `.cairn/tasks/active/${args.taskId}/`,
  };
}

export interface TaskAttestationState {
  rootAttestation: boolean;
  subagentAttestations: number;
  phase: string | null;
}

/**
 * Read the attestation state for an active task. Used by the Stop
 * hook auto-graduator to decide whether to close a task whose work
 * landed without an explicit `cairn_task_complete` call (rare —
 * happens when an opt-in reviewer subagent wrote attestation.yaml
 * but the surrounding session ended before the close call).
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

  const phase = readPhase(join(taskDir, "status.yaml"));

  return {
    rootAttestation,
    subagentAttestations,
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

  // Bump status.yaml mtime so the stalled-task detector (which reads
  // mtime on status.yaml) sees a journal-only turn as live activity.
  // Without this, journaling without a status edit lets the idle clock
  // fire mid-active-work.
  //
  // Also stamp `last_journal_session` so the stall scan can tell which
  // session is currently working the task — two concurrent CC sessions
  // sharing one `.cairn/` must not see each other's tasks as stalled
  // ("owned by another session" vs "abandoned").
  const statusPath = join(taskDir, "status.yaml");
  if (existsSync(statusPath)) {
    if (args.sessionId !== null && args.sessionId !== "") {
      try {
        const status = readStatusYaml(statusPath);
        const prev = typeof status["last_journal_session"] === "string"
          ? (status["last_journal_session"] as string)
          : null;
        if (prev !== args.sessionId) {
          status["last_journal_session"] = args.sessionId;
          writeFileSync(statusPath, stringifyYaml(status), "utf8");
        }
      } catch {
        // Best-effort — mtime bump below still happens.
      }
    }
    const now = new Date();
    try {
      utimesSync(statusPath, now, now);
    } catch {
      // Best-effort — mtime bump is a hint, not a contract.
    }
  }
  return true;
}

/**
 * Read the session-affinity stamps off a task's `status.yaml`. Returns
 * nulls for tasks created before the affinity stamping was wired in
 * (pre-0.13.x adoptions). Stall scan uses this to decide whether to
 * surface a 30m-idle task to the current session.
 */
export function readTaskSessionAffinity(
  repoRoot: string,
  taskId: string,
): { createdBySession: string | null; lastJournalSession: string | null } {
  const statusPath = join(repoRoot, ".cairn", "tasks", "active", taskId, "status.yaml");
  if (!existsSync(statusPath)) {
    return { createdBySession: null, lastJournalSession: null };
  }
  try {
    const status = readStatusYaml(statusPath);
    return {
      createdBySession:
        typeof status["created_by_session"] === "string"
          ? (status["created_by_session"] as string)
          : null,
      lastJournalSession:
        typeof status["last_journal_session"] === "string"
          ? (status["last_journal_session"] as string)
          : null,
    };
  } catch {
    return { createdBySession: null, lastJournalSession: null };
  }
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
