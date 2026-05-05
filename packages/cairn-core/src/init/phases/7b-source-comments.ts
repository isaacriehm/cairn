/**
 * Phase 7b-source-comments — walk every source file's docblock-class
 * comment, classify via Haiku, write DEC drafts / invariant proposals.
 */

import {
  runSourceCommentsIngestion,
  type IngestSourceCommentsResult,
} from "../source-comments/index.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase7bSourceComments(state: PhaseState): Promise<PhaseResult> {
  try {
    const result: IngestSourceCommentsResult = await runSourceCommentsIngestion({
      repoRoot: state.repoRoot,
    });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "7b-source-comments": result },
    };
    return {
      status: "complete",
      nextPhase: "7c-rules-merge",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "source-comments-failed",
        message: "Source-comment ingestion failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
