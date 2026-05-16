import { reopenTask } from "../../tasks/index.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { taskReopenInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  task_id: string;
  reason?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const result = reopenTask({
    repoRoot: ctx.repoRoot,
    taskId: input.task_id,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    source: "cairn_task_reopen",
  });

  if (!result.ok) {
    if (result.code === "TASK_NOT_FOUND") {
      return mcpError("TASK_NOT_FOUND", result.message);
    }
    if (result.code === "NOT_IN_DONE") {
      return mcpError("VALIDATION_FAILED", result.message);
    }
    if (result.code === "ACTIVE_DIR_COLLISION") {
      return mcpError("INTERNAL_ERROR", result.message);
    }
    return mcpError("INTERNAL_ERROR", result.message);
  }

  return {
    ok: true,
    task_id: result.taskId,
    reopened_at: result.reopenedAt,
    moved_to: result.movedTo,
  };
}

export const taskReopenTool: ToolDef<Input> = {
  name: "cairn_task_reopen",
  description:
    "Move a completed task from `tasks/done/<id>/` back to `tasks/active/<id>/`. Resets `phase: running`, archives any existing `attestation.yaml` so the Stop hook auto-graduator doesn't immediately re-close the task, and emits a `task-reopened` event. Use when `cairn_task_complete` graduated the wrong task (rare — typically from omitting `task_id` and picking up a parallel-session active task) or when an operator decides shipped work needs more changes. Reversible via `cairn_task_complete`.",
  inputSchema: taskReopenInput,
  handler,
};
