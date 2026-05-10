/**
 * Mission cursor advance helpers — shared logic between the explicit
 * `cairn_mission_advance` MCP tool, the Stop hook auto-advance path
 * (exit_gate=auto), and the Stop hook prompt path (exit_gate=prompt
 * after operator picks `a`).
 */

import {
  type MissionPhase,
  type MissionRoadmapFrontmatter,
  type MissionState,
  appendMissionJournal,
  archiveMission,
  countDonePhases,
  nextPendingPhase,
  readMissionState,
  readRoadmap,
  writeMissionState,
} from "@isaacriehm/cairn-state";

export interface AdvanceResult {
  ok: true;
  phase_advanced: string;
  next_phase: MissionPhase | null;
  /** True when this advance closed the mission. */
  closed: boolean;
  donePhases: number;
  totalPhases: number;
}

export interface AdvanceError {
  ok: false;
  code:
    | "MISSION_NOT_FOUND"
    | "PHASE_NOT_FOUND"
    | "PHASE_ALREADY_DONE"
    | "ROADMAP_MISSING"
    | "STATE_MISSING";
  message: string;
}

/**
 * Mark `phaseId` as done in `phase_progress` and pick the next pending
 * phase whose `depends_on` set is satisfied. When no eligible phase
 * remains, set `cursor.active_phase = null`, mark `outcome: done`, and
 * archive the mission dirs.
 */
export function advancePhase(
  repoRoot: string,
  missionId: string,
  phaseId: string,
  now: Date = new Date(),
): AdvanceResult | AdvanceError {
  const roadmap = readRoadmap(repoRoot, missionId);
  if (roadmap === null) {
    return { ok: false, code: "ROADMAP_MISSING", message: `roadmap.md missing for ${missionId}` };
  }
  const state = readMissionState(repoRoot, missionId);
  if (state === null) {
    return { ok: false, code: "STATE_MISSING", message: `state.json missing for ${missionId}` };
  }
  const phaseDef = roadmap.frontmatter.phases.find((p) => p.id === phaseId);
  if (phaseDef === undefined) {
    return { ok: false, code: "PHASE_NOT_FOUND", message: `phase ${phaseId} not in roadmap` };
  }
  const progress = state.phase_progress[phaseId];
  if (progress?.state === "done") {
    return { ok: false, code: "PHASE_ALREADY_DONE", message: `phase ${phaseId} already done` };
  }

  const ts = now.toISOString();
  state.phase_progress[phaseId] = {
    state: "done",
    task_ids: progress?.task_ids ?? [],
    graduated_at: ts,
  };

  const next = nextPendingPhase(roadmap.frontmatter, state);
  if (next !== null) {
    state.cursor.active_phase = next.id;
    state.cursor.active_phase_started_at = ts;
    state.phase_progress[next.id] = {
      state: "in_progress",
      task_ids: state.phase_progress[next.id]?.task_ids ?? [],
    };
  } else {
    state.cursor.active_phase = null;
    state.cursor.active_phase_started_at = null;
    state.outcome = "done";
    state.closed_at = ts;
  }

  writeMissionState(repoRoot, missionId, state);
  appendMissionJournal(repoRoot, missionId, {
    ts,
    kind: "phase-advanced",
    phase_id: phaseId,
    detail: next !== null ? `next: ${next.id}` : "mission complete",
  });

  let closed = false;
  if (next === null) {
    appendMissionJournal(repoRoot, missionId, {
      ts,
      kind: "closed",
      detail: "auto-close on last phase complete",
    });
    archiveMission(repoRoot, missionId);
    closed = true;
  }

  return {
    ok: true,
    phase_advanced: phaseId,
    next_phase: next,
    closed,
    donePhases: countDonePhases(state),
    totalPhases: roadmap.frontmatter.phases.length,
  };
}

/**
 * Determine whether every linked task on a phase has graduated.
 * Returns `false` when the phase has zero tasks (the operator has to
 * `mission_advance --force` for empty phases — never auto-advance an
 * empty phase silently).
 */
export function allPhaseTasksDone(
  state: MissionState,
  phaseId: string,
  taskIsDone: (taskId: string) => boolean,
): boolean {
  const progress = state.phase_progress[phaseId];
  if (progress === undefined) return false;
  if (progress.task_ids.length === 0) return false;
  return progress.task_ids.every(taskIsDone);
}

/**
 * Resolve a roadmap phase by id from a mission's roadmap. Returns null
 * when the id was deleted in a mid-mission roadmap edit (drift case).
 */
export function lookupPhase(
  roadmap: MissionRoadmapFrontmatter,
  phaseId: string,
): MissionPhase | null {
  return roadmap.phases.find((p) => p.id === phaseId) ?? null;
}
