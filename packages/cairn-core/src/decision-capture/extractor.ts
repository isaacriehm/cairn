/**
 * Decision-extractor runner.
 *
 * Single Tier-1 (Haiku) call by default per workflow.md
 * `decision_extractor: 1`. Output is gated by `--json-schema`. The wrapper
 * validates shape via a runtime guard and returns the typed payload.
 *
 * The runner does NOT touch the filesystem. It returns the extractor's
 * structured output; the writer + confirm flow handle persistence.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import {
  DECISION_EXTRACTOR_SYSTEM_PROMPT,
  buildDecisionExtractorUserPrompt,
} from "./prompt.js";
import { DECISION_EXTRACTOR_OUTPUT_SCHEMA } from "./schema.js";
import type {
  CandidateAssertion,
  DecisionExtractorInput,
  DecisionExtractorOutput,
} from "./types.js";

const log = logger("decision-capture.extractor");

export interface ExtractorResult {
  output: DecisionExtractorOutput;
  duration_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function runDecisionExtractor(
  input: DecisionExtractorInput,
): Promise<ExtractorResult> {
  const userPrompt = buildDecisionExtractorUserPrompt(input);

  log.info(
    {
      tier: input.tier,
      raw_text_len: input.raw_text.length,
      accepted_decisions: input.accepted_decisions?.length ?? 0,
    },
    "decision-extractor dispatch",
  );

  const result = await runClaude({
    tier: input.tier,
    prompt: userPrompt,
    system: DECISION_EXTRACTOR_SYSTEM_PROMPT,
    jsonSchema: DECISION_EXTRACTOR_OUTPUT_SCHEMA as object,
    timeoutMs: input.timeout_ms ?? 120_000,
  });

  if (!isOutput(result.parsed)) {
    throw new Error(
      `decision-extractor returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }

  const output = result.parsed;

  log.info(
    {
      not_a_decision: output.not_a_decision,
      subject_preview: output.subject.slice(0, 80),
      assertions: output.candidate_assertions.length,
      confidence: output.confidence_signal,
      duration_ms: result.durationMs,
    },
    "decision-extractor complete",
  );

  return {
    output,
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

function isOutput(value: unknown): value is DecisionExtractorOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["subject"] !== "string") return false;
  if (typeof v["summary"] !== "string") return false;
  if (!Array.isArray(v["scope_globs"])) return false;
  for (const g of v["scope_globs"] as unknown[]) {
    if (typeof g !== "string") return false;
  }
  const supersedes = v["supersedes"];
  if (
    supersedes !== undefined &&
    supersedes !== null &&
    typeof supersedes !== "string"
  ) {
    return false;
  }
  if (!Array.isArray(v["candidate_assertions"])) return false;
  for (const a of v["candidate_assertions"] as unknown[]) {
    if (!isCandidateAssertion(a)) return false;
  }
  if (
    v["confidence_signal"] !== "high" &&
    v["confidence_signal"] !== "medium" &&
    v["confidence_signal"] !== "low"
  ) {
    return false;
  }
  if (typeof v["not_a_decision"] !== "boolean") return false;
  return true;
}

function isCandidateAssertion(value: unknown): value is CandidateAssertion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["kind"] !== "string") return false;
  if (typeof v["description"] !== "string") return false;
  return true;
}
