/**
 * Question agent (Phase 11.y).
 *
 * Read-only Q&A agent that the operator invokes via the ❓ Ask path
 * during UAT approval. Reads the bundle's tightened spec, diff paths,
 * UAT summary (acceptance results + evidence pointers), reviewer
 * verdict + summary, and decisions in scope. Returns one structured
 * answer per question.
 *
 * Per UAT_PIPELINE.md §7. Tier 1 (Haiku) default — cheap, no file
 * write tools.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import type { ClaudeTier } from "../claude/index.js";
import type { UatSummary } from "./types.js";

const log = logger("uat.question");

export interface QuestionAgentInput {
  question: string;
  /** Tightened spec body the implementer received. */
  tightened_spec: string;
  /** Acceptance criteria the implementer was given. */
  acceptance_criteria: string[];
  /** Files changed in the run (paths + status only — content is omitted to
   *  keep the question agent cheap). */
  changed_files: { path: string; status: string }[];
  /** UAT summary (probe results + evidence pointers + sensors passed). */
  summary: UatSummary;
  /** Reviewer verdict + summary text. */
  reviewer?: { verdict: "pass" | "fail"; summary: string };
  /** In-scope decision ids — the agent may cite by id. */
  decision_ids?: string[];
  /** Tier — Haiku default, Sonnet via override for thorny questions. */
  tier?: ClaudeTier;
  /** Per-call timeout. Default 120_000 ms. */
  timeout_ms?: number;
}

export interface QuestionAgentOutput {
  answer: string;
  /** Self-reported confidence in the answer. */
  confidence_signal: "high" | "medium" | "low";
  /** Citations pointing back to the bundle (e.g. "summary.yaml#AC2",
   *  "diff:src/foo.ts", "decision:DEC-0042"). */
  citations: string[];
}

const QUESTION_AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    confidence_signal: { enum: ["high", "medium", "low"] },
    citations: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "confidence_signal", "citations"],
} as const;

export const QUESTION_AGENT_SYSTEM_PROMPT = [
  "You are the UAT QUESTION agent in a developer harness.",
  "",
  "The operator has just inspected a UAT bundle and asked you a question. Your job is to answer it from the bundle alone — you have no file-write tools, no shell, no ability to re-run sensors. You read the tightened spec, the changed-file paths, the UAT acceptance results, and the reviewer's verdict, and you produce ONE concise answer.",
  "",
  "Rules:",
  "  - Answer the question directly. No preamble. No 'Great question!'.",
  "  - If the bundle does not contain the information needed, say so explicitly. Don't invent context.",
  "  - When you reference something, cite it: `summary.yaml#AC2`, `diff:src/foo.ts`, `decision:DEC-0042`.",
  "  - `confidence_signal`:",
  "    - `high` — the answer is supported by an explicit acceptance result, sensor pass, or quoted file path.",
  "    - `medium` — the answer is reasonable inference from the bundle but not directly stated.",
  "    - `low` — the bundle is sparse or your answer is best-guess; tell the operator they need to inspect manually.",
  "  - Keep `answer` to 1-3 short paragraphs. The operator is on their phone.",
  "",
  "Return ONLY the JSON object. No markdown wrapper.",
].join("\n");

function isOutput(value: unknown): value is QuestionAgentOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["answer"] !== "string") return false;
  if (
    v["confidence_signal"] !== "high" &&
    v["confidence_signal"] !== "medium" &&
    v["confidence_signal"] !== "low"
  ) {
    return false;
  }
  if (!Array.isArray(v["citations"])) return false;
  return true;
}

function buildUserPrompt(input: QuestionAgentInput): string {
  const parts: string[] = [];
  parts.push("# Operator's question");
  parts.push("");
  parts.push(input.question.trim());
  parts.push("");
  parts.push("# Tightened spec");
  parts.push("");
  parts.push(input.tightened_spec.trim());
  if (input.acceptance_criteria.length > 0) {
    parts.push("");
    parts.push("# Acceptance criteria");
    parts.push("");
    for (const a of input.acceptance_criteria) parts.push(`- ${a}`);
  }
  if (input.changed_files.length > 0) {
    parts.push("");
    parts.push("# Files changed (paths only)");
    parts.push("");
    for (const f of input.changed_files) parts.push(`- ${f.path} (${f.status})`);
  }
  parts.push("");
  parts.push("# UAT summary");
  parts.push("");
  parts.push(`Goal: ${input.summary.goal_one_liner}`);
  parts.push(
    `Diff stats: ${input.summary.diff_stats.files_changed} files, +${input.summary.diff_stats.lines_added} / -${input.summary.diff_stats.lines_removed}`,
  );
  parts.push("");
  parts.push("Acceptance results:");
  for (const r of input.summary.acceptance_results) {
    const reason = r.failure_reason ? ` — ${r.failure_reason}` : "";
    parts.push(`- ${r.id} (${r.probe_kind}): ${r.status}${reason}`);
  }
  if (input.summary.cold_start_smoke) {
    parts.push("");
    parts.push(`Cold-start smoke: ${input.summary.cold_start_smoke.status}`);
  }
  parts.push("");
  parts.push(`Sensors passed: ${input.summary.sensors_passed.join(", ") || "(none)"}`);
  parts.push(`Reviewer subagent verdict: ${input.summary.reviewer_subagent_verdict}`);
  if (input.reviewer && input.reviewer.summary) {
    parts.push("");
    parts.push(`Reviewer summary: ${input.reviewer.summary}`);
  }
  if (input.decision_ids && input.decision_ids.length > 0) {
    parts.push("");
    parts.push(`Decisions in scope: ${input.decision_ids.join(", ")}`);
  }
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("Now answer the operator's question. Return ONLY the JSON object.");
  return parts.join("\n");
}

export async function runQuestionAgent(input: QuestionAgentInput): Promise<QuestionAgentOutput> {
  const tier: ClaudeTier = input.tier ?? "haiku";
  log.info(
    {
      tier,
      question_chars: input.question.length,
      ac_count: input.acceptance_criteria.length,
      diff_files: input.changed_files.length,
    },
    "question agent dispatch",
  );
  const result = await runClaude({
    tier,
    prompt: buildUserPrompt(input),
    system: QUESTION_AGENT_SYSTEM_PROMPT,
    jsonSchema: QUESTION_AGENT_SCHEMA as object,
    timeoutMs: input.timeout_ms ?? 120_000,
  });
  if (!isOutput(result.parsed)) {
    throw new Error(
      `question agent returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }
  log.info(
    {
      answer_chars: result.parsed.answer.length,
      confidence: result.parsed.confidence_signal,
      citations: result.parsed.citations.length,
      duration_ms: result.durationMs,
    },
    "question agent complete",
  );
  return result.parsed;
}
