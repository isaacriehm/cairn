/**
 * Phase 5b — topic-index build (cross-source dedup pre-pass).
 *
 * Walks every prose-bearing source the SoT model recognizes, computes
 * content-fingerprint slugs, resolves verbatim collisions by priority
 * order, and asks Haiku to judge cross-source semantic-similarity
 * collisions (Jaccard ≥ 0.6, distinct slug). Writes the resulting
 * TopicIndex + AnchorMap to `.cairn/ground/`.
 *
 * Phase 6 / 7b / 7c read this index before emitting any DEC: when a
 * candidate prose block matches a topic that already lives in another
 * source's SoT path, the lower-priority occurrence becomes a
 * §DEC-<hash> cite rather than a fresh DEC. Without this pass the
 * v0.5.0 ledger would still drift toward the v0.4.x cross-source
 * duplication problem.
 *
 * No operator input. Always advances.
 */

import { logger } from "../../logger.js";
import { buildTopicIndex } from "../topic-index/index.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

const log = logger("init.phases.5b-topic-index");

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

export async function runPhase5bTopicIndex(state: PhaseState): Promise<PhaseResult> {
  try {
    const result = await buildTopicIndex({ repoRoot: state.repoRoot });
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
      outputs: { ...state.outputs, "5b-topic-index": out },
      answer: undefined,
    };
    log.info(out, "phase 5b complete");
    return {
      status: "complete",
      nextPhase: "6-docs-ingest",
      state: advancePhase(next),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "phase 5b failed");
    return {
      status: "error",
      error: {
        code: "topic-index-failed",
        message: `Phase 5b (topic-index) failed: ${message}`,
      },
      state,
    };
  }
}
