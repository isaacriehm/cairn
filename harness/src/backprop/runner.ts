/**
 * Backprop subagent runner — Phase 13.
 *
 * Single Tier-N call (Sonnet by default per workflow.md `backprop_author: 2`)
 * via the `claude` subprocess. Output is gated by `--json-schema`. The
 * harness consumes the structured payload, allocates a monotonic V-id,
 * and writes both the invariant file + the enforcement artifact.
 *
 * The runner does NOT commit. The orchestrator commits after the writer
 * succeeds, so a failed write doesn't leave a half-written invariant in
 * the mirror.
 */

import { runClaude } from "../claude/index.js";
import { logger } from "../logger.js";
import { allocateInvariantId } from "./id.js";
import { buildBackpropUserPrompt, BACKPROP_SYSTEM_PROMPT } from "./prompt.js";
import { BACKPROP_OUTPUT_SCHEMA } from "./schema.js";
import { writeInvariantArtifacts } from "./writer.js";
import type { BackpropInput, BackpropOutput, BackpropResult } from "./types.js";

const log = logger("backprop");

export interface RunBackpropArgs extends BackpropInput {
  /** Mirror path the artifacts are written into. */
  mirrorPath: string;
}

export async function runBackprop(args: RunBackpropArgs): Promise<BackpropResult> {
  const userPrompt = buildBackpropUserPrompt(args);

  log.info(
    {
      tier: args.tier,
      diff_files: args.diff.length,
      run_id: args.run_id,
      decisions: args.in_scope_decision_ids.length,
    },
    "backprop dispatch",
  );

  const result = await runClaude({
    tier: args.tier,
    prompt: userPrompt,
    system: BACKPROP_SYSTEM_PROMPT,
    jsonSchema: BACKPROP_OUTPUT_SCHEMA as object,
    timeoutMs: args.timeout_ms ?? 300_000,
  });

  if (!isOutput(result.parsed)) {
    throw new Error(
      `backprop returned malformed output. preview: ${result.text.slice(0, 200)}`,
    );
  }

  const output = result.parsed;
  const invariantId = allocateInvariantId(args.mirrorPath);
  const writeResult = writeInvariantArtifacts({
    repoRoot: args.mirrorPath,
    invariantId,
    output,
    runId: args.run_id,
  });

  log.info(
    {
      invariant_id: invariantId,
      slug: output.slug,
      enforcement: output.enforcement.kind,
      invariant_path: writeResult.invariant_path,
      sensor_path: writeResult.sensor_path,
      duration_ms: result.durationMs,
    },
    "backprop complete",
  );

  return {
    id: invariantId,
    invariant_path: writeResult.invariant_path,
    sensor_path: writeResult.sensor_path,
    output,
    tier: args.tier,
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

function isOutput(value: unknown): value is BackpropOutput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["slug"] !== "string") return false;
  if (typeof v["title"] !== "string") return false;
  if (typeof v["body_markdown"] !== "string") return false;
  if (typeof v["introduced_for_bug"] !== "string") return false;
  const enforcement = v["enforcement"];
  if (typeof enforcement !== "object" || enforcement === null) return false;
  const e = enforcement as Record<string, unknown>;
  if (e["kind"] !== "regex_sensor" && e["kind"] !== "named_e2e") return false;
  return true;
}
