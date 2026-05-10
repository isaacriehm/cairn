/**
 * Task ↔ mission linkage. Called by `cairn_task_complete` and the Stop
 * hook auto-graduator after a task transitions to a terminal phase.
 *
 * Reads the task's status.yaml for the `mission_id` + `phase_id`
 * stamps, appends the task id to `phase_progress[phaseId].task_ids` if
 * not already present, and decides whether the phase is now ready to
 * exit.
 *
 * - exit_gate=auto   → advance cursor immediately.
 * - exit_gate=prompt → emit `phase_ready_to_exit` invalidation event;
 *                      Stop hook surfaces the AskUserQuestion next tick.
 * - exit_gate=manual → no-op; operator runs `cairn mission advance`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * `tasks/done/<id>/` exists → the task graduated to a terminal phase
 * (succeeded / failed / aborted). The mission task-completion linkage
 * only counts `succeeded`; the upstream caller filters by outcome
 * before invoking onTaskCompleted, so a present `done/<id>/` here
 * means a sibling already graduated successfully.
 */
function taskIsCompletedOnDisk(repoRoot: string, taskId: string): boolean {
  const dir = join(repoRoot, ".cairn", "tasks", "done", taskId);
  if (!existsSync(dir)) return false;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
import {
  appendMissionJournal,
  effectivePhaseExitGate,
  readMissionState,
  readRoadmap,
  writeMissionState,
} from "@isaacriehm/cairn-state";
import { writeInvalidationEvent } from "../events/index.js";
import { advancePhase, allPhaseTasksDone } from "./cursor.js";

export interface TaskMissionAnchor {
  mission_id: string;
  phase_id: string;
}

/** Read the mission anchor stamped on a task's status.yaml. */
export function readTaskMissionAnchor(
  repoRoot: string,
  taskId: string,
): TaskMissionAnchor | null {
  const candidates = [
    join(repoRoot, ".cairn", "tasks", "active", taskId, "status.yaml"),
    join(repoRoot, ".cairn", "tasks", "done", taskId, "status.yaml"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const missionId = obj["mission_id"];
    const phaseId = obj["phase_id"];
    if (typeof missionId === "string" && typeof phaseId === "string" && missionId.length > 0) {
      return { mission_id: missionId, phase_id: phaseId };
    }
  }
  return null;
}

/** Append `taskId` to a phase's `task_ids` if not already linked. */
export function linkTaskToPhase(
  repoRoot: string,
  missionId: string,
  phaseId: string,
  taskId: string,
): boolean {
  const state = readMissionState(repoRoot, missionId);
  if (state === null) return false;
  const progress = state.phase_progress[phaseId] ?? {
    state: "in_progress" as const,
    task_ids: [] as string[],
  };
  if (!progress.task_ids.includes(taskId)) {
    progress.task_ids = [...progress.task_ids, taskId];
    state.phase_progress[phaseId] = progress;
    writeMissionState(repoRoot, missionId, state);
    appendMissionJournal(repoRoot, missionId, {
      ts: new Date().toISOString(),
      kind: "task-attached",
      phase_id: phaseId,
      task_id: taskId,
    });
    return true;
  }
  return false;
}

export type TaskCompletionLink =
  | { kind: "no-mission" }
  | { kind: "linked"; mission_id: string; phase_id: string; gate: "prompt" | "auto" | "manual" }
  | {
      kind: "phase-advanced";
      mission_id: string;
      phase_id: string;
      next_phase: string | null;
      mission_closed: boolean;
    }
  | {
      kind: "phase-ready-to-exit";
      mission_id: string;
      phase_id: string;
    };

/**
 * Called after a task graduates to `succeeded` (only). Reads the
 * task's mission anchor, links the task id, and either advances the
 * cursor (gate=auto) or emits a `phase_ready_to_exit` invalidation
 * event for the Stop hook (gate=prompt).
 *
 * Failed/aborted tasks are NOT linked (a failed task does not satisfy
 * a phase exit). Pass-through `no-mission` when the task wasn't
 * mission-anchored.
 */
export function onTaskCompleted(
  repoRoot: string,
  taskId: string,
  outcome: "succeeded" | "failed" | "aborted",
  taskIsDone: (id: string) => boolean = (id) => taskIsCompletedOnDisk(repoRoot, id),
): TaskCompletionLink {
  if (outcome !== "succeeded") return { kind: "no-mission" };
  const anchor = readTaskMissionAnchor(repoRoot, taskId);
  if (anchor === null) return { kind: "no-mission" };

  linkTaskToPhase(repoRoot, anchor.mission_id, anchor.phase_id, taskId);

  const roadmap = readRoadmap(repoRoot, anchor.mission_id);
  const state = readMissionState(repoRoot, anchor.mission_id);
  if (roadmap === null || state === null) {
    return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate: "manual" };
  }

  const gate = effectivePhaseExitGate(roadmap.frontmatter, anchor.phase_id) ?? roadmap.frontmatter.exit_gate;
  if (!allPhaseTasksDone(state, anchor.phase_id, taskIsDone)) {
    return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate };
  }

  if (gate === "auto") {
    const r = advancePhase(repoRoot, anchor.mission_id, anchor.phase_id);
    if (r.ok) {
      return {
        kind: "phase-advanced",
        mission_id: anchor.mission_id,
        phase_id: anchor.phase_id,
        next_phase: r.next_phase?.id ?? null,
        mission_closed: r.closed,
      };
    }
    return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate };
  }

  if (gate === "prompt") {
    try {
      writeInvalidationEvent(repoRoot, {
        kind: "phase-ready-to-exit",
        refs: [{ kind: "task", id: taskId }],
        source: { session_id: null, tool: "cairn_task_complete" },
        path: `.cairn/missions/${anchor.mission_id}/state.json`,
      });
    } catch {
      // best-effort
    }
    return {
      kind: "phase-ready-to-exit",
      mission_id: anchor.mission_id,
      phase_id: anchor.phase_id,
    };
  }

  return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate };
}
