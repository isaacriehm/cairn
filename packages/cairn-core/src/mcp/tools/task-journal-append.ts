/**
 * `cairn_task_journal_append` — append a per-turn journal entry to
 * the active task. The journal is the authoritative record that
 * survives `/clear` so a fresh session can resume cold.
 *
 * Cairn-as-resume-layer: main Claude calls this at the end of every
 * assistant turn while a task is active. Stop hook surfaces a context-
 * threshold prompt when usage crosses the configured limit; the
 * `/cairn-resume <task_id>` slash command in the next session reads
 * the journal back via `cairn_resume`.
 */

import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { taskJournalAppendInput } from "../schemas.js";
import type { ToolDef } from "./types.js";
import { appendTaskJournal, findCurrentActiveTask } from "../../tasks/index.js";

interface Input {
  task_id?: string;
  summary: string;
  next_step?: string;
  files_touched?: string[];
  decisions_loaded?: string[];
  session_id?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const taskId = input.task_id ?? findCurrentActiveTask(ctx.repoRoot);
  if (taskId === null) {
    return mcpError(
      "TASK_NOT_FOUND",
      "no active task — call cairn_task_create first or pass task_id explicitly",
    );
  }

  const ok = appendTaskJournal({
    repoRoot: ctx.repoRoot,
    taskId,
    sessionId: input.session_id ?? null,
    summary: input.summary,
    ...(input.next_step !== undefined ? { nextStep: input.next_step } : {}),
    ...(input.files_touched !== undefined ? { filesTouched: input.files_touched } : {}),
    ...(input.decisions_loaded !== undefined ? { decisionsLoaded: input.decisions_loaded } : {}),
  });

  if (!ok) {
    return mcpError(
      "TASK_NOT_FOUND",
      `active task directory missing: .cairn/tasks/active/${taskId}/`,
    );
  }

  return { ok: true, task_id: taskId };
}

export const taskJournalAppendTool: ToolDef<Input> = {
  name: "cairn_task_journal_append",
  description:
    "Append one journal entry to the active task's journal.jsonl. Call at the end of every assistant turn while a task is active so that `/cairn-resume <task_id>` after a `/clear` rebuilds the operator's mental state cold. `summary` is a ≤160-char one-liner of what just happened; `next_step` is what comes next. `task_id` is optional — Cairn picks the most-recently-touched active task when omitted.",
  inputSchema: taskJournalAppendInput,
  handler,
};
