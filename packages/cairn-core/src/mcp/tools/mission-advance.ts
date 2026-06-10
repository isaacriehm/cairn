import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { cairnDir,
  appendMissionJournal,
  findActiveMission,
  readMissionState,
  readRoadmap,
  writeMissionState,
} from "@isaacriehm/cairn-state";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { missionAdvanceInput } from "../schemas.js";
import { advanceMissionPhase as advancePhase } from "../../missions/index.js";
import type { ToolDef } from "./types.js";

/**
 * Read a graduated task's outcome from `.cairn/tasks/done/<id>/status.yaml`.
 * The `phase` field is overloaded — `task-create` writes `phase: running`,
 * `task-complete` rewrites it to the outcome string (`succeeded` / `failed`
 * / `aborted`). Returns "unknown" when the file is missing or unreadable.
 */
function readGraduatedOutcome(repoRoot: string, taskId: string): string {
  const statusPath = cairnDir(repoRoot, "tasks", "done", taskId, "status.yaml");
  if (!existsSync(statusPath)) return "unknown";
  try {
    const raw = readFileSync(statusPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^phase:\s*(\S+)/);
      if (m && m[1] !== undefined) return m[1].replace(/['"]/g, "");
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function writeMissionPhaseDefer(
  repoRoot: string,
  missionId: string,
  phaseId: string,
  hours: number,
): string {
  const now = new Date();
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000);
  const payload = {
    mission_id: missionId,
    phase_id: phaseId,
    deferred_at: now.toISOString(),
    deferred_until: until.toISOString(),
  };
  const path = cairnDir(repoRoot, ".mission-phase-deferred-until");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return until.toISOString();
}

/**
 * Unlink `.mission-phase-deferred-until` if it references the given
 * mission+phase pair. Called when the phase actually advances (exit /
 * force) or when the parent mission closes — keeping a stale marker
 * around suppresses the prompt for a phase that no longer needs it.
 *
 * A stale marker left after a deferred phase auto-advances would
 * otherwise suppress phase-ready prompts on unrelated missions until
 * the 24h expiry rolled past.
 */
export function clearMissionPhaseDeferIfMatches(
  repoRoot: string,
  match: { missionId: string; phaseId?: string },
): boolean {
  const path = cairnDir(repoRoot, ".mission-phase-deferred-until");
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      mission_id?: string;
      phase_id?: string;
    };
    if (parsed.mission_id !== match.missionId) return false;
    if (match.phaseId !== undefined && parsed.phase_id !== match.phaseId) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

interface Input {
  phase_id: string;
  choice: "exit" | "not_yet" | "defer" | "force" | "drop";
  defer_hours?: number;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const missionId = findActiveMission(ctx.repoRoot);
  if (missionId === null) {
    return mcpError("MISSION_NOT_FOUND", "No active mission");
  }

  const roadmap = readRoadmap(ctx.repoRoot, missionId);
  const state = readMissionState(ctx.repoRoot, missionId);
  if (roadmap === null || state === null) {
    return mcpError("MISSION_NOT_FOUND", `Mission ${missionId} state or roadmap unreadable`);
  }
  const phaseInRoadmap = roadmap.frontmatter.phases.some((p) => p.id === input.phase_id);

  // choice=drop is the drift resolver — phase_id intentionally NOT in
  // roadmap.md anymore (operator deleted it mid-mission). Removes the
  // phase from phase_progress and journals the drift resolution.
  if (input.choice === "drop") {
    if (phaseInRoadmap) {
      return mcpError(
        "VALIDATION_FAILED",
        `phase ${input.phase_id} is still in roadmap.md; choice=drop only resolves drifted ids. Use choice=exit/force to advance an in-roadmap phase.`,
      );
    }
    if (!(input.phase_id in state.phase_progress)) {
      return mcpError(
        "MISSION_PHASE_NOT_FOUND",
        `phase ${input.phase_id} not present in phase_progress (nothing to drop)`,
      );
    }
    const taskIds = state.phase_progress[input.phase_id]?.task_ids ?? [];
    delete state.phase_progress[input.phase_id];
    writeMissionState(ctx.repoRoot, missionId, state);
    appendMissionJournal(ctx.repoRoot, missionId, {
      ts: new Date().toISOString(),
      kind: "drift-detected",
      phase_id: input.phase_id,
      detail: `dropped — ${taskIds.length} graduated task(s) orphaned`,
    });
    return {
      ok: true,
      action: "dropped",
      mission_id: missionId,
      phase_id: input.phase_id,
      orphaned_task_ids: taskIds,
    };
  }

  if (!phaseInRoadmap) {
    return mcpError("MISSION_PHASE_NOT_FOUND", `phase ${input.phase_id} not in roadmap`);
  }

  if (input.choice === "not_yet") {
    // Clear `ready_emitted` so the next task-completion in this phase
    // re-fires the phase-ready prompt. Without this, `task-link.ts`
    // skips the re-emit and the operator never gets prompted again
    // until the cursor actually advances or the mission reopens.
    const progress = state.phase_progress[input.phase_id];
    if (progress !== undefined && progress.ready_emitted === true) {
      state.phase_progress[input.phase_id] = { ...progress, ready_emitted: false };
      writeMissionState(ctx.repoRoot, missionId, state);
    }
    // Persist the deferral so the next session (post `/clear`) does
    // not re-fire the same phase-exit AskUserQuestion. The defer file
    // only suppresses the cross-session SessionStart re-ask; in-session
    // re-emit on a new task completion still flows via the
    // `ready_emitted = false` reset above.
    const deferredUntil = writeMissionPhaseDefer(
      ctx.repoRoot,
      missionId,
      input.phase_id,
      24,
    );
    appendMissionJournal(ctx.repoRoot, missionId, {
      ts: new Date().toISOString(),
      kind: "phase-deferred",
      phase_id: input.phase_id,
      detail: "operator chose not_yet (deferred 24h cross-session)",
    });
    return {
      ok: true,
      action: "deferred",
      mission_id: missionId,
      phase_id: input.phase_id,
      deferred_until: deferredUntil,
    };
  }

  if (input.choice === "defer") {
    const hours = input.defer_hours ?? 24;
    const deferredUntil = writeMissionPhaseDefer(ctx.repoRoot, missionId, input.phase_id, hours);
    appendMissionJournal(ctx.repoRoot, missionId, {
      ts: new Date().toISOString(),
      kind: "phase-deferred",
      phase_id: input.phase_id,
      detail: `defer ${hours}h`,
    });
    return {
      ok: true,
      action: "deferred",
      mission_id: missionId,
      phase_id: input.phase_id,
      deferred_until: deferredUntil,
    };
  }

  // choice === "exit" || "force"
  if (input.choice === "exit") {
    // Cursor validation — `exit` is the cursor-honouring advance. Reject
    // out-of-order phase exits so a caller can't skip an incomplete phase
    // by submitting a later phase_id (which would orphan the skipped
    // phase and corrupt progress accounting). Operator must use `force`
    // to skip ahead intentionally.
    const cursorPhase = state.cursor.active_phase;
    if (cursorPhase !== null && cursorPhase !== input.phase_id) {
      return mcpError(
        "VALIDATION_FAILED",
        `phase_id ${input.phase_id} is not the active cursor (cursor on ${cursorPhase}). ` +
          `Use choice="force" to intentionally skip ahead, or call cairn_mission_advance against ${cursorPhase} first.`,
      );
    }

    const progress = state.phase_progress[input.phase_id];
    if (progress === undefined || progress.task_ids.length === 0) {
      return mcpError(
        "VALIDATION_FAILED",
        `phase ${input.phase_id} has no linked tasks. Pass choice="force" to advance an empty phase.`,
      );
    }

    // Failed-task gate — refuse to mark a phase as graduated if every
    // linked task ended in failure, which would leave the mission
    // journal claiming "phase done" while no work succeeded. Force can
    // still skip, but it requires explicit operator intent.
    const outcomes = progress.task_ids.map((id) => readGraduatedOutcome(ctx.repoRoot, id));
    const hasUngraduated = outcomes.some((o) => o === "unknown");
    const hasSucceeded = outcomes.some((o) => o === "succeeded");
    if (!hasUngraduated && !hasSucceeded) {
      return mcpError(
        "VALIDATION_FAILED",
        `phase ${input.phase_id} has linked tasks but none with outcome=succeeded ` +
          `(outcomes: ${outcomes.join(", ")}). Use choice="force" to intentionally skip ` +
          `a phase that did not succeed, or choice="defer" to suppress the prompt without advancing.`,
      );
    }
  }

  const result = advancePhase(ctx.repoRoot, missionId, input.phase_id);
  if (!result.ok) {
    return mcpError(
      result.code === "PHASE_NOT_FOUND"
        ? "MISSION_PHASE_NOT_FOUND"
        : result.code === "MISSION_NOT_FOUND"
          ? "MISSION_NOT_FOUND"
          : "VALIDATION_FAILED",
      result.message,
    );
  }

  // Phase actually advanced — clear any prior `not_yet` / `defer`
  // marker that was suppressing this phase's prompt.
  clearMissionPhaseDeferIfMatches(ctx.repoRoot, {
    missionId,
    phaseId: input.phase_id,
  });

  return {
    ok: true,
    action: result.closed ? "closed" : "advanced",
    mission_id: missionId,
    phase_advanced: result.phase_advanced,
    next_phase: result.next_phase?.id ?? null,
    next_phase_title: result.next_phase?.title ?? null,
    progress: { done: result.donePhases, total: result.totalPhases },
    closed: result.closed,
  };
}

export const missionAdvanceTool: ToolDef<Input> = {
  name: "cairn_mission_advance",
  description:
    "Resolve a phase-exit prompt (or manually advance the mission). " +
    "**Pick `choice` based on intent**: " +
    "`exit` — phase work is done, advance the cursor. Refused when (a) `phase_id` is not the active cursor (use `force` to skip ahead), (b) the phase has zero linked tasks, or (c) every linked task ended `failed`/`aborted`. If you hit (b) the phase truly is empty — pass `force`. If you hit (c) the phase didn't succeed — pass `force` to skip explicitly or `defer` to suppress the prompt. " +
    "`force` — advance regardless of cursor / task linkage / outcomes (skip a phase that wasn't worked on, or one that failed). " +
    "`not_yet` — keep cursor on this phase; next `cairn_task_create` auto-attaches here. Use when more work is pending. " +
    "`defer` — suppress the phase-exit prompt for `defer_hours` (default 24) without changing cursor. " +
    "`drop` — remove a drifted phase id from `phase_progress` (id was deleted from `roadmap.md` mid-mission); refused if still in `roadmap.md`. " +
    "When advance hits the last pending phase, mission auto-closes and archives. " +
    "**Common UX**: after completing work and committing, call with `choice=exit`. The 'no linked tasks' error means the task was never created via `cairn_task_create` — go create one and retry.",
  inputSchema: missionAdvanceInput,
  handler,
};
