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

const SUMMARY_ADVISORY = 320;

/**
 * Soft-truncate to `advisory` chars with a trailing marker. Returns the
 * unchanged string when it fits. Splits at the last word boundary
 * before the cap to avoid mid-token truncation.
 */
function softTruncate(s: string, advisory: number): { value: string; truncated: boolean } {
  if (s.length <= advisory) return { value: s, truncated: false };
  // Reserve room for the marker so the final string lands at ≤advisory.
  const removed = s.length - advisory;
  const markerSuffix = `…[+${removed} chars truncated]`;
  const keep = Math.max(0, advisory - markerSuffix.length);
  let cut = s.slice(0, keep);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > advisory - 80) cut = cut.slice(0, lastSpace);
  return { value: cut + markerSuffix, truncated: true };
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

  const summaryResult = softTruncate(input.summary, SUMMARY_ADVISORY);
  const nextStepResult =
    input.next_step !== undefined ? softTruncate(input.next_step, SUMMARY_ADVISORY) : null;

  const ok = appendTaskJournal({
    repoRoot: ctx.repoRoot,
    taskId,
    sessionId: input.session_id ?? null,
    summary: summaryResult.value,
    ...(nextStepResult !== null ? { nextStep: nextStepResult.value } : {}),
    ...(input.files_touched !== undefined ? { filesTouched: input.files_touched } : {}),
    ...(input.decisions_loaded !== undefined ? { decisionsLoaded: input.decisions_loaded } : {}),
  });

  if (!ok) {
    return mcpError(
      "TASK_NOT_FOUND",
      `active task directory missing: .cairn/tasks/active/${taskId}/`,
    );
  }

  const truncatedFields: string[] = [];
  if (summaryResult.truncated) truncatedFields.push("summary");
  if (nextStepResult?.truncated === true) truncatedFields.push("next_step");

  return {
    ok: true,
    task_id: taskId,
    ...(truncatedFields.length > 0 ? { truncated: truncatedFields } : {}),
  };
}

export const taskJournalAppendTool: ToolDef<Input> = {
  name: "cairn_task_journal_append",
  description:
    "Append one journal entry to the active task's journal.jsonl. Call at the end of every assistant turn while a task is active so that `/cairn-resume <task_id>` after a `/clear` rebuilds the operator's mental state cold. " +
    "`summary` is a terse one-liner (~320 chars; soft-truncated above that with a trailing marker — no validation reject). " +
    "`next_step` is what comes next, same length budget. " +
    "`task_id` is optional — Cairn picks the most-recently-touched active task when omitted. " +
    "Response includes `truncated: [field…]` when any input was soft-truncated.",
  inputSchema: taskJournalAppendInput,
  handler,
};
