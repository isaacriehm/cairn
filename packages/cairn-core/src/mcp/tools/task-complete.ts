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
    "Graduate an active task (`.cairn/tasks/active/<task_id>/`) to a terminal phase (succeeded / failed / aborted) and move its directory to `.cairn/tasks/done/`. Called by the reviewer subagent after writing attestation.yaml, by the cairn-direction skill on a confirmed pivot, or by the Stop-hook auto-graduator. Returns TASK_NOT_FOUND if the task was already completed.",
  inputSchema: taskCompleteInput,
  handler,
};
