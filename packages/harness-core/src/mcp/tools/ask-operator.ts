/**
 * harness_ask_operator — agent-initiated operator dialog mid-run.
 *
 * The implementer agent calls this when it hits an ambiguity, needs
 * permission for a non-recoverable action, gets stuck, or wants to
 * verify its interpretation. The flow:
 *
 *   1. Tool writes a question file under
 *      `.harness/runs/active/<run_id>/questions/<question_id>.q.json`.
 *   2. The orchestrator's question-watcher (chokidar) picks it up,
 *      fires `adapter.requestDialog()` with the active operator
 *      pinged (so they see it on mobile push).
 *   3. Operator answers via Discord button (or free-form follow-up
 *      if no `options` were provided).
 *   4. The orchestrator writes the answer to
 *      `.harness/runs/active/<run_id>/questions/<question_id>.a.json`.
 *   5. This tool polls for the answer file and returns its contents to
 *      the agent.
 *
 * The agent run continues with the operator's answer in context. If
 * `timeout_ms` elapses before the operator answers, the tool returns
 * `{ timed_out: true }` and the agent decides what to do (default:
 * abort with a remediation note).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { askOperatorInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  run_id: string;
  question: string;
  options?: string[];
  category?: "ambiguity" | "permission" | "stuck" | "verify";
  timeout_ms?: number;
}

interface AnswerPayload {
  answered_at: string;
  /** Operator's free-text answer when no options given, OR the chosen option text. */
  answer: string;
  /** When options were provided, the chosen choice id (e.g. "a"/"b"). */
  choice_id?: string;
  /** True when the operator picked "E) Other" + free-text. */
  free_text?: boolean;
  timed_out?: boolean;
}

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

async function handler(
  ctx: McpContext,
  input: Input,
): Promise<unknown> {
  const runDir = join(
    ctx.repoRoot,
    ".harness",
    "runs",
    "active",
    input.run_id,
  );
  if (!existsSync(runDir)) {
    return mcpError(
      "RUN_NOT_FOUND",
      `No active run dir at ${runDir}. ask_operator must be called from within an in-flight run.`,
    );
  }

  const questionsDir = join(runDir, "questions");
  mkdirSync(questionsDir, { recursive: true });
  const questionId = `Q-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const qPath = join(questionsDir, `${questionId}.q.json`);
  const aPath = join(questionsDir, `${questionId}.a.json`);

  const qPayload = {
    id: questionId,
    run_id: input.run_id,
    asked_at: new Date().toISOString(),
    question: input.question,
    ...(input.options !== undefined && input.options.length > 0
      ? { options: input.options }
      : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };
  writeFileSync(qPath, JSON.stringify(qPayload, null, 2), "utf8");

  // Poll for the answer file. The orchestrator's question-watcher
  // observes the question, fires the dialog, writes the answer.
  const deadline = Date.now() + (input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (existsSync(aPath)) {
      try {
        const raw = readFileSync(aPath, "utf8");
        const answer = JSON.parse(raw) as AnswerPayload;
        return {
          ok: true,
          question_id: questionId,
          answer: answer.answer,
          ...(answer.choice_id !== undefined ? { choice_id: answer.choice_id } : {}),
          ...(answer.free_text === true ? { free_text: true } : {}),
          ...(answer.timed_out === true ? { timed_out: true } : {}),
        };
      } catch (err) {
        return mcpError(
          "VALIDATION_FAILED",
          `Failed to parse answer file ${aPath}: ${String(err)}`,
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: true,
    question_id: questionId,
    answer: "",
    timed_out: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const askOperatorTool: ToolDef<Input> = {
  name: "harness_ask_operator",
  description:
    "Stop and ask the operator a question. Use when the spec is genuinely ambiguous, you need permission for a non-recoverable action, you're stuck, or you want the operator to verify your interpretation. Provide 2-4 short option strings if the answer fits a closed set; omit `options` to invite a free-form reply. The tool blocks until the operator answers or `timeout_ms` (default 10 minutes) elapses.",
  inputSchema: askOperatorInput,
  handler,
};
