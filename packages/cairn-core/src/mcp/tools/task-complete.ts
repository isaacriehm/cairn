/**
 * `cairn_task_complete` — graduate an active task to a terminal phase
 * and move its directory to `.cairn/tasks/done/`.
 *
 * Tasks created by `cairn_task_create` start at `phase: running`.
 * This tool is the explicit terminal write — called by the reviewer
 * subagent after attestation, by the cairn-direction skill on a
 * confirmed pivot, or by the Stop-hook auto-graduator when the
 * reviewer attestation lands.
 *
 * Outcomes:
 *   - `succeeded` — work complete, attestation present
 *   - `failed`    — work attempted but did not pass acceptance
 *   - `aborted`   — task abandoned (operator pivoted, scope removed)
 */

import { existsSync, readFileSync } from "node:fs";

import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { taskCompleteInput } from "../schemas.js";
import type { ToolDef } from "./types.js";
import {
  completeTask,
  findCurrentActiveTask,
  readTaskSessionAffinity,
} from "../../tasks/index.js";
import { cairnDir,
  findActiveMission,
  readMissionState,
  readRoadmap,
} from "@isaacriehm/cairn-state";

interface Input {
  task_id?: string;
  outcome: "succeeded" | "failed" | "aborted";
  summary?: string;
}

const SUMMARY_ADVISORY = 2000;

/**
 * Soft-truncate to `advisory` chars with a trailing marker. Returns
 * the unchanged string when it fits. Splits at the last word boundary
 * before the cap to avoid mid-token truncation.
 */
function softTruncate(s: string, advisory: number): { value: string; truncated: boolean } {
  if (s.length <= advisory) return { value: s, truncated: false };
  const removed = s.length - advisory;
  const markerSuffix = `…[+${removed} chars truncated]`;
  const keep = Math.max(0, advisory - markerSuffix.length);
  let cut = s.slice(0, keep);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > advisory - 200) cut = cut.slice(0, lastSpace);
  return { value: cut + markerSuffix, truncated: true };
}

interface GraduatedTaskSummary {
  task_id: string;
  title: string;
  outcome: string;
}

interface NextActionHint {
  kind: "continue-phase" | "next-phase" | "mission-complete" | "phase-ready-to-exit";
  mission_id: string;
  cursor_phase: string | null;
  cursor_phase_title: string | null;
  exit_criteria: string | null;
  graduated_tasks: GraduatedTaskSummary[];
  instruction: string;
}

/**
 * Read the `title:` and `phase: <terminal>` from a done task's
 * `status.yaml`. Best-effort — returns the task id as title when the
 * file is missing or malformed (keeps the hint useful even on
 * partial state). Cheap line scan; no full YAML parse on the hot
 * path.
 */
function readGraduatedTaskSummary(
  repoRoot: string,
  taskId: string,
): GraduatedTaskSummary {
  const statusPath = cairnDir(repoRoot, "tasks", "done", taskId, "status.yaml");
  const fallback: GraduatedTaskSummary = {
    task_id: taskId,
    title: taskId,
    outcome: "unknown",
  };
  if (!existsSync(statusPath)) return fallback;
  try {
    const raw = readFileSync(statusPath, "utf8");
    let title = taskId;
    let outcome = "unknown";
    for (const line of raw.split(/\r?\n/)) {
      const t = line.match(/^title:\s*(.+)$/);
      if (t && t[1] !== undefined) title = t[1].trim().replace(/^['"]|['"]$/g, "");
      const p = line.match(/^phase:\s*(\S+)/);
      if (p && p[1] !== undefined) outcome = p[1].replace(/['"]/g, "");
    }
    return { task_id: taskId, title, outcome };
  } catch {
    return fallback;
  }
}

/**
 * Build the post-completion `next_action_hint` block that tells the
 * model what to do next, enabling autonomous mission continuation
 * without operator handoff. The block answers four questions in one
 * payload:
 *
 *   1. Is there an active mission? (no → omit entirely; caller stops)
 *   2. Is the cursor still on a phase? (yes → continue or pivot)
 *   3. What's the phase's exit criteria? (so the model can identify
 *      which PRs / sub-tasks are still pending)
 *   4. Which tasks already graduated under this phase? (so the model
 *      doesn't re-spawn already-done work)
 *
 * The `instruction` field is a literal directive the model reads
 * verbatim — it tells the model to either call `cairn_task_create`
 * for the next gap, or end the turn cleanly when the mission has
 * closed. Returns `null` when there's no mission anchor or the
 * outcome was failed/aborted (don't auto-chain past a failure).
 *
 * Skipped when `cairn_task_complete` already returned a
 * `phase_ready_to_exit` block — that surface owns the operator
 * prompt and the model shouldn't be told to auto-create the next
 * task in the same turn (it would race the AskUserQuestion).
 */
function buildNextActionHint(
  repoRoot: string,
  outcome: "succeeded" | "failed" | "aborted",
  phaseReadyAlreadySurfaced: boolean,
): NextActionHint | null {
  if (outcome !== "succeeded") return null;
  if (phaseReadyAlreadySurfaced) return null;

  const missionId = findActiveMission(repoRoot);
  if (missionId === null) return null;

  const roadmap = readRoadmap(repoRoot, missionId);
  const state = readMissionState(repoRoot, missionId);
  if (roadmap === null || state === null) return null;

  const cursor = state.cursor.active_phase;
  if (cursor === null) {
    return {
      kind: "mission-complete",
      mission_id: missionId,
      cursor_phase: null,
      cursor_phase_title: null,
      exit_criteria: null,
      graduated_tasks: [],
      instruction:
        "Mission complete — all phases done. No further `cairn_task_create` calls needed. End your turn after reporting status.",
    };
  }

  const phaseDef = roadmap.frontmatter.phases.find((p) => p.id === cursor);
  if (phaseDef === undefined) return null;

  const progress = state.phase_progress[cursor];
  const graduatedIds = progress?.task_ids ?? [];
  const graduated = graduatedIds.map((id) => readGraduatedTaskSummary(repoRoot, id));

  // When the just-completed task pushed cursor to a new phase silently
  // (gate=auto), the new cursor differs from the phase that the task
  // was anchored to. `phase_ready_to_exit === null` AND the cursor's
  // phase_progress shows `in_progress` with empty task_ids → fresh
  // phase, no work started. Surface a "next-phase" hint distinct from
  // "continue-phase" so the model knows the cursor advanced.
  const kind: "continue-phase" | "next-phase" =
    progress?.state === "in_progress" && graduatedIds.length === 0
      ? "next-phase"
      : "continue-phase";

  const summary = graduated
    .map((g) => `  • ${g.task_id} — ${g.title} (${g.outcome})`)
    .join("\n");

  const instruction =
    kind === "next-phase"
      ? [
          `Cursor advanced silently (exit_gate=auto). New phase: \`${cursor}\` — ${phaseDef.title}.`,
          ``,
          `Exit criteria:`,
          `  ${phaseDef.exit_criteria}`,
          ``,
          `No tasks graduated under this phase yet. To continue the mission autonomously:`,
          `  1. Identify the first PR / sub-deliverable named in the exit criteria.`,
          `  2. Call \`cairn_task_create\` for it (omit \`mission_id\` and \`phase_id\` — the cursor auto-stamps both).`,
          `  3. Execute the work in this same turn.`,
          ``,
          `If the operator's original prompt requested autonomous execution ("just keep going", "execute the mission", etc.), proceed without re-prompting. Only stop when the next task's spec needs disambiguation that can't be inferred from the phase exit criteria.`,
        ].join("\n")
      : [
          `Active mission: \`${missionId}\` — cursor on phase \`${cursor}\` (${phaseDef.title}).`,
          ``,
          `Exit criteria:`,
          `  ${phaseDef.exit_criteria}`,
          ``,
          `Graduated tasks under this phase so far (${graduated.length}):`,
          summary.length > 0 ? summary : "  (none — this phase has no prior graduations)",
          ``,
          `To continue the mission autonomously:`,
          `  1. Re-read the exit criteria above. Identify a PR / sub-deliverable NOT covered by the graduated task titles.`,
          `  2. If a gap exists, call \`cairn_task_create\` for it (omit \`mission_id\` and \`phase_id\` — the cursor auto-stamps both) and start work in this same turn.`,
          `  3. If the phase's exit criteria appears fully covered but the auto-graduator hasn't moved the cursor, call \`cairn_mission_advance({phase_id: "${cursor}", choice: "exit"})\` to advance, then start the next phase.`,
          ``,
          `If the operator's original prompt requested autonomous execution ("just keep going", "execute the mission", etc.), proceed without re-prompting. Only stop when the next task's spec needs disambiguation that can't be inferred from the phase exit criteria.`,
        ].join("\n");

  return {
    kind,
    mission_id: missionId,
    cursor_phase: cursor,
    cursor_phase_title: phaseDef.title,
    exit_criteria: phaseDef.exit_criteria,
    graduated_tasks: graduated,
    instruction,
  };
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  let taskId = input.task_id ?? null;

  if (taskId === null) {
    // No explicit task_id — pick the current active task, but ONLY if
    // it belongs to this session. Bug-mine: a parallel session with no
    // active task of its own picked up another session's active task
    // by mtime and graduated it silently. With session-affinity stamps,
    // we can now require explicit task_id when the implicit pick would
    // cross a session boundary.
    const implicit = findCurrentActiveTask(ctx.repoRoot);
    if (implicit === null) {
      return mcpError(
        "TASK_NOT_FOUND",
        "no active task — pass task_id explicitly or call cairn_task_create first",
      );
    }
    const affinity = readTaskSessionAffinity(ctx.repoRoot, implicit);
    const sid = ctx.sessionId ?? null;
    const owner = affinity.lastJournalSession ?? affinity.createdBySession ?? null;
    if (
      sid !== null &&
      owner !== null &&
      owner !== sid
    ) {
      return mcpError(
        "VALIDATION_FAILED",
        `Implicit active task ${implicit} was last touched by a different session (${owner}). Pass task_id explicitly so you don't accidentally graduate another session's work.`,
      );
    }
    taskId = implicit;
  }

  const summaryResult = input.summary !== undefined ? softTruncate(input.summary, SUMMARY_ADVISORY) : null;

  const result = completeTask({
    repoRoot: ctx.repoRoot,
    taskId,
    outcome: input.outcome,
    ...(summaryResult !== null ? { summary: summaryResult.value } : {}),
    source: "cairn_task_complete",
  });

  if (!result.ok) {
    if (result.code === "TASK_NOT_FOUND" || result.code === "ALREADY_COMPLETED") {
      return mcpError("TASK_NOT_FOUND", result.message);
    }
    return mcpError("INTERNAL_ERROR", result.message);
  }

  // When the task graduating closed out a `gate=prompt` phase, the
  // completion ALSO means the operator owes a phase-exit decision.
  // Surface the structured metadata in the tool response; the caller
  // (cairn-direction skill / cairn-attention skill) decides whether
  // to surface the prompt via `AskUserQuestion` based on operator
  // autonomy state. The Stop hook's auto-graduator path still writes
  // the pending file + a `systemMessage` warning so UPS picks the
  // hint up on the next prompt when the model isn't in the loop.
  const phaseReady = result.phase_ready_to_exit;
  if (phaseReady !== null) {
    return {
      ok: true,
      task_id: result.taskId,
      outcome: result.outcome,
      completed_at: result.completedAt,
      moved_to: result.movedTo,
      ...(summaryResult?.truncated === true ? { truncated: ["summary"] } : {}),
      phase_ready_to_exit: {
        mission_id: phaseReady.mission_id,
        mission_title: phaseReady.mission_title,
        phase_id: phaseReady.phase_id,
        phase_title: phaseReady.phase_title,
        exit_criteria: phaseReady.exit_criteria,
      },
    };
  }

  const nextAction = buildNextActionHint(ctx.repoRoot, input.outcome, false);
  if (nextAction !== null) {
    return {
      ok: true,
      task_id: result.taskId,
      outcome: result.outcome,
      completed_at: result.completedAt,
      moved_to: result.movedTo,
      ...(summaryResult?.truncated === true ? { truncated: ["summary"] } : {}),
      next_action_hint: nextAction,
    };
  }

  return {
    ok: true,
    task_id: result.taskId,
    outcome: result.outcome,
    completed_at: result.completedAt,
    moved_to: result.movedTo,
    ...(summaryResult?.truncated === true ? { truncated: ["summary"] } : {}),
  };
}

export const taskCompleteTool: ToolDef<Input> = {
  name: "cairn_task_complete",
  description:
    "Graduate an active task (`.cairn/tasks/active/<task_id>/`) to a terminal phase (succeeded / failed / aborted) and move its directory to `.cairn/tasks/done/`. `task_id` is optional — defaults to the most-recently-touched active task. Called by the reviewer subagent after writing attestation.yaml, by the cairn-direction skill on a confirmed pivot, or by the Stop-hook auto-graduator. Returns TASK_NOT_FOUND if the task was already completed or no active task exists. When the completion satisfies the active phase's exit criteria under `exit_gate=prompt`, the response includes a structured `phase_ready_to_exit` block (mission_id, mission_title, phase_id, phase_title, exit_criteria); the caller decides whether to surface a phase-exit prompt — typical flow is `AskUserQuestion` before ending the turn unless the operator's running autonomously. When the task was mission-anchored, succeeded, and no phase-exit prompt fired, the response also carries a `next_action_hint` block telling the model what to do next (continue with the next pending PR in the cursor phase, start the auto-advanced next phase, or end the turn because the mission closed). The hint is the autonomous-continuation contract: the model reads `next_action_hint.instruction` and either calls `cairn_task_create` for the gap or ends the turn cleanly.",
  inputSchema: taskCompleteInput,
  handler,
};
