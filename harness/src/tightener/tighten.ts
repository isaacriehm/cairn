import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import { buildTightenerUserPrompt, TIGHTENER_SYSTEM_PROMPT } from "./prompt.js";
import { TIGHTENER_OUTPUT_SCHEMA } from "./schema.js";
import type { TightenerInput, TightenerOutput, TightenerResult } from "./types.js";

const log = logger("tightener");

/** Word-count cutoff at which we auto-escalate from Haiku → Sonnet. */
const ESCALATE_WORDS = 500;

/** Default `spec_quality_floor` per templates/.harness/config/workflow.md. */
const DEFAULT_QUALITY_FLOOR = 7;

function chooseTier(input: TightenerInput): "haiku" | "sonnet" {
  if (input.force_tier !== undefined) return input.force_tier;
  const wordCount = `${input.title} ${input.body}`.split(/\s+/).filter(Boolean).length;
  return wordCount > ESCALATE_WORDS ? "sonnet" : "haiku";
}

function isOutput(value: unknown): value is TightenerOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v["ambiguities"]) &&
    Array.isArray(v["conflicts"]) &&
    Array.isArray(v["missing_acceptance"]) &&
    Array.isArray(v["scope_concerns"]) &&
    Array.isArray(v["existing_stub_overlap"]) &&
    typeof v["spec_quality_score"] === "number" &&
    typeof v["ready_to_execute"] === "boolean" &&
    typeof v["tightened_spec_proposal"] === "string"
  );
}

export async function tightenSpec(input: TightenerInput): Promise<TightenerResult> {
  const tier = chooseTier(input);
  const userPrompt = buildTightenerUserPrompt(input);

  log.info(
    { tier, body_len: input.body.length, ship_anyway: input.ship_anyway === true },
    "tightener dispatch",
  );

  const result = await runClaude({
    tier,
    prompt: userPrompt,
    system: TIGHTENER_SYSTEM_PROMPT,
    jsonSchema: TIGHTENER_OUTPUT_SCHEMA as object,
    timeoutMs: 300_000,
  });

  if (!isOutput(result.parsed)) {
    throw new Error(
      `tightener returned malformed output (no parsed). preview: ${result.text.slice(0, 200)}`,
    );
  }

  const output = result.parsed;
  const ready =
    input.ship_anyway === true ||
    (output.ready_to_execute === true && output.spec_quality_score >= DEFAULT_QUALITY_FLOOR);

  return {
    output,
    tier,
    ready,
    quality_floor: DEFAULT_QUALITY_FLOOR,
    duration_ms: result.durationMs,
    ...(result.usage !== undefined
      ? {
          usage: {
            ...(result.usage.input_tokens !== undefined
              ? { input_tokens: result.usage.input_tokens }
              : {}),
            ...(result.usage.output_tokens !== undefined
              ? { output_tokens: result.usage.output_tokens }
              : {}),
          },
        }
      : {}),
  };
}
