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

import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { taskCompleteInput } from "../schemas.js";
import type { ToolDef } from "./types.js";
import { completeTask } from "../../tasks/index.js";

interface Input {
  task_id: string;
  outcome: "succeeded" | "failed" | "aborted";
  summary?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const result = completeTask({
    repoRoot: ctx.repoRoot,
    taskId: input.task_id,
    outcome: input.outcome,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
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
  // Surface that inline in the tool response with a literal render
  // instruction. The calling model invokes `AskUserQuestion` in the
  // SAME turn — no hook handoff, no Stop-banner. The Stop hook's
  // auto-graduator path still writes the pending file + a
  // `systemMessage` warning so the operator knows to wake UPS on
  // the next prompt when the model isn't in the loop.
  const phaseReady = result.phase_ready_to_exit;
  if (phaseReady !== null) {
    return {
      ok: true,
      task_id: result.taskId,
      outcome: result.outcome,
      completed_at: result.completedAt,
      moved_to: result.movedTo,
      phase_ready_to_exit: {
        mission_id: phaseReady.mission_id,
        mission_title: phaseReady.mission_title,
        phase_id: phaseReady.phase_id,
        phase_title: phaseReady.phase_title,
        exit_criteria: phaseReady.exit_criteria,
        render_instruction: [
          `The phase \`${phaseReady.phase_title}\` is ready to exit (all linked tasks graduated). Surface this question to the operator via \`AskUserQuestion\` BEFORE ending your turn:`,
          ``,
          `> Phase \`${phaseReady.phase_title}\` looks done. Move on?`,
          `>`,
          `> Exit criteria: ${phaseReady.exit_criteria}`,
          `>`,
          `> - [a] Mark phase done, advance to next phase`,
          `> - [b] Keep working on this phase`,
          ``,
          `On [a], call \`cairn_mission_advance({phase_id: "${phaseReady.phase_id}", choice: "exit"})\`. On [b], call \`cairn_mission_advance({phase_id: "${phaseReady.phase_id}", choice: "not_yet"})\`.`,
        ].join("\n"),
      },
    };
  }

  return {
    ok: true,
    task_id: result.taskId,
    outcome: result.outcome,
    completed_at: result.completedAt,
    moved_to: result.movedTo,
  };
}

export const taskCompleteTool: ToolDef<Input> = {
  name: "cairn_task_complete",
  description:
    "Graduate an active task (`.cairn/tasks/active/<task_id>/`) to a terminal phase (succeeded / failed / aborted) and move its directory to `.cairn/tasks/done/`. Called by the reviewer subagent after writing attestation.yaml, by the cairn-direction skill on a confirmed pivot, or by the Stop-hook auto-graduator. Returns TASK_NOT_FOUND if the task was already completed. When the completion satisfies the active phase's exit criteria under `exit_gate=prompt`, the response includes a `phase_ready_to_exit` block carrying a literal `render_instruction` — the caller MUST surface the operator question via `AskUserQuestion` in the same turn before ending.",
  inputSchema: taskCompleteInput,
  handler,
};
