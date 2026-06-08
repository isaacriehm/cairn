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

/**
 * Extract PR-shaped tokens from a phase's `exit_criteria` prose. The
 * pattern matches things like `3.5-MK2`, `3.5-HSH1`, `1.2-AUTH99` —
 * `<digit-cluster>.<digit>-<ALPHA><digits>`. Free-form prose with no
 * matching tokens returns an empty list (caller falls back to plain
 * `allPhaseTasksDone` accounting).
 */
const PR_SLUG_RE = /\b\d+\.\d+-[A-Z]+\d+\b/g;

function extractExitCriteriaPrSlugs(exitCriteria: string): string[] {
  const matches = exitCriteria.match(PR_SLUG_RE);
  if (matches === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Returns true when any task id covers the named PR slug. Slug `3.5-MK2`
 * is checked two ways: full slug normalized to lower-kebab
 * (`3-5-mk2`) appears as a substring of the task id, OR the bare PR
 * token (`mk2`) appears as a kebab-delimited segment of the task id.
 * The cairn-direction Step 2.6b auto-pick embeds the PR token into
 * the task slug directly, so substring matching is reliable. Case
 * insensitive throughout.
 */
function graduatedIdsCoverPrSlug(taskIds: string[], prSlug: string): boolean {
  const fullKebab = prSlug.replace(/\./g, "-").toLowerCase();
  const bareToken = prSlug.split("-").slice(1).join("-").toLowerCase();
  for (const id of taskIds) {
    const lower = id.toLowerCase();
    if (lower.includes(fullKebab)) return true;
    if (bareToken.length > 0 && new RegExp(`(^|-)${bareToken}(-|$)`).test(lower)) {
      return true;
    }
  }
  return false;
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
      mission_title: string;
      phase_id: string;
      phase_title: string;
      exit_criteria: string;
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

  // Cross-check: if the phase's exit_criteria enumerates PR slugs
  // (e.g. `3.5-MK2`, `3.5-MK3`), refuse to fire phase-ready until a
  // task has graduated for each named PR. Counting `task_ids.length`
  // alone passes false-positive when only some PRs ever got a task.
  // Free-form exit criteria with no PR slugs skip this check —
  // `allPhaseTasksDone` is authoritative there.
  const phaseDef = roadmap.frontmatter.phases.find((p) => p.id === anchor.phase_id);
  const exitCriteriaText = phaseDef?.exit_criteria ?? "";
  const prSlugs = extractExitCriteriaPrSlugs(exitCriteriaText);
  if (prSlugs.length > 0) {
    const graduatedIds = state.phase_progress[anchor.phase_id]?.task_ids ?? [];
    const missing = prSlugs.filter(
      (slug) => !graduatedIdsCoverPrSlug(graduatedIds, slug),
    );
    if (missing.length > 0) {
      return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate };
    }
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
    // Idempotency: only emit `phase-ready-to-exit` once per phase. Once
    // the operator has been prompted, follow-up task completions in the
    // same phase (e.g. operator added another TSK after seeing the
    // prompt) do NOT re-fire the surface. The flag clears on advance /
    // reopen via `cursor.ts`.
    const progress = state.phase_progress[anchor.phase_id];
    if (progress?.ready_emitted === true) {
      return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate };
    }

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

    if (progress !== undefined) {
      state.phase_progress[anchor.phase_id] = { ...progress, ready_emitted: true };
      try {
        writeMissionState(repoRoot, anchor.mission_id, state);
      } catch {
        // best-effort — at worst we re-emit on the next task completion
      }
    }

    return {
      kind: "phase-ready-to-exit",
      mission_id: anchor.mission_id,
      mission_title: roadmap.frontmatter.title,
      phase_id: anchor.phase_id,
      phase_title: phaseDef?.title ?? anchor.phase_id,
      exit_criteria: phaseDef?.exit_criteria ?? "",
    };
  }

  return { kind: "linked", mission_id: anchor.mission_id, phase_id: anchor.phase_id, gate };
}
