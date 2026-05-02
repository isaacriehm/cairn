/**
 * Reviewer subagent runner — Phase 10.
 *
 * Single Tier-N call (matching the implementer's tier per L15) via the
 * `claude` subprocess. Output is gated by `--json-schema`; we read it
 * from `structured_output` in the envelope.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import { buildReviewerUserPrompt, REVIEWER_SYSTEM_PROMPT } from "./prompt.js";
import { REVIEWER_OUTPUT_SCHEMA } from "./schema.js";
import type {
  ReviewGap,
  ReviewerInput,
  ReviewerOutput,
  ReviewerResult,
} from "./types.js";

const log = logger("reviewer");

function isOutput(value: unknown): value is ReviewerOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["verdict"] !== "pass" && v["verdict"] !== "fail") return false;
  if (!Array.isArray(v["gaps"])) return false;
  for (const g of v["gaps"] as unknown[]) {
    if (typeof g !== "object" || g === null) return false;
    const gg = g as Record<string, unknown>;
    if (typeof gg["category"] !== "string") return false;
    if (typeof gg["description"] !== "string") return false;
    if (gg["severity"] !== "hard" && gg["severity"] !== "soft") return false;
  }
  if (
    v["confidence_signal"] !== "high" &&
    v["confidence_signal"] !== "medium" &&
    v["confidence_signal"] !== "low"
  ) {
    return false;
  }
  if (typeof v["summary"] !== "string") return false;
  return true;
}

export async function runReviewer(input: ReviewerInput): Promise<ReviewerResult> {
  const userPrompt = buildReviewerUserPrompt(input);

  log.info(
    {
      tier: input.tier,
      diff_files: input.diff.length,
      decisions: input.decisions_in_scope.length,
      soft_findings: input.soft_findings.length,
      high_stakes: input.is_high_stakes,
    },
    "reviewer dispatch",
  );

  const result = await runClaude({
    tier: input.tier,
    prompt: userPrompt,
    system: REVIEWER_SYSTEM_PROMPT,
    jsonSchema: REVIEWER_OUTPUT_SCHEMA as object,
    timeoutMs: input.timeout_ms ?? 300_000,
  });

  if (!isOutput(result.parsed)) {
    throw new Error(
      `reviewer returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }

  const output = result.parsed;
  const hardGaps = output.gaps.filter((g: ReviewGap) => g.severity === "hard");
  const ok = output.verdict === "pass" && hardGaps.length === 0;

  log.info(
    {
      verdict: output.verdict,
      gap_count: output.gaps.length,
      hard_gaps: hardGaps.length,
      confidence: output.confidence_signal,
      duration_ms: result.durationMs,
    },
    "reviewer complete",
  );

  return {
    output,
    tier: input.tier,
    ok,
    duration_ms: result.durationMs,
    ...(result.usage !== undefined
      ? {
          usage: {
            ...(result.usage["input_tokens"] !== undefined
              ? { input_tokens: result.usage["input_tokens"] }
              : {}),
            ...(result.usage["output_tokens"] !== undefined
              ? { output_tokens: result.usage["output_tokens"] }
              : {}),
          },
        }
      : {}),
  };
}
