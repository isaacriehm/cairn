/**
 * Phase 7-topic-index — topic-index build (cross-source dedup pre-pass).
 *
 * Walks every prose-bearing source the SoT model recognizes, computes
 * content-fingerprint slugs, resolves verbatim collisions by priority
 * order, and asks Haiku to judge cross-source semantic-similarity
 * collisions (Jaccard ≥ 0.6, distinct slug). Writes the resulting
 * TopicIndex + AnchorMap to `.cairn/ground/`.
 */

import { logger } from "../../logger.js";
import { buildTopicIndex } from "../topic-index/index.js";
import { recordSample } from "../eta-calibration.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

const log = logger("init.phases.7-topic-index");

export interface TopicIndexPhaseOutput {
  block_count: number;
  verbatim_collisions: number;
  semantic_collisions: number;
  judge_calls: number;
  unresolved_ambiguous: number;
  topic_count: number;
  topic_index_path: string;
  anchor_map_path: string;
}

export async function runPhase7TopicIndex(state: PhaseState): Promise<PhaseResult> {
  const startedAt = performance.now();
  try {
    const result = await buildTopicIndex({ repoRoot: state.repoRoot });
    const durationMs = Math.round(performance.now() - startedAt);
    if (result.judgeCalls > 0) {
      recordSample({
        phase: "7-topic-index",
        units: result.judgeCalls,
        durationMs,
      });
    }
    const topicCount = Object.keys(result.topicIndex.topics).length;
    const out: TopicIndexPhaseOutput = {
      block_count: result.blockCount,
      verbatim_collisions: result.verbatimCollisions,
      semantic_collisions: result.semanticCollisions,
      judge_calls: result.judgeCalls,
      unresolved_ambiguous: result.unresolvedAmbiguous,
      topic_count: topicCount,
      topic_index_path: result.topicIndexPath,
      anchor_map_path: result.anchorMapPath,
    };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "7-topic-index": out },
      answer: undefined,
    };
    log.info(out, "phase 7 complete");
    return {
      status: "complete",
      nextPhase: "8-docs-ingest",
      state: advancePhase(next),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "phase 7 failed");
    return {
      status: "error",
      error: {
        code: "topic-index-failed",
        message: `Phase 7 (topic-index) failed: ${message}`,
      },
      state,
    };
  }
}
