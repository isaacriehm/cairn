/**
 * Phase 9-source-comments — walk every source file's docblock-class
 * comment, classify via Haiku, write DEC drafts / invariant proposals.
 */

import {
  runSourceCommentsIngestion,
  type IngestSourceCommentsResult,
} from "../source-comments/index.js";
import { clearProgress } from "../progress.js";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import {
  to7bResultPersisted,
  writeSourceCommentsWalkFile,
  type IngestSourceCommentsResultPersisted,
} from "./source-comments-output-io.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase9SourceComments(state: PhaseState): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    const skipped: IngestSourceCommentsResultPersisted = { skipped: "self-adopt" as const };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9-source-comments": skipped },
    };
    return {
      status: "complete",
      nextPhase: "10-rules-merge",
      state: advancePhase(next),
    };
  }

  try {
    const result: IngestSourceCommentsResult = await runSourceCommentsIngestion({
      repoRoot: state.repoRoot,
    });
    writeSourceCommentsWalkFile(state.repoRoot, result);
    const persisted = to7bResultPersisted(result);
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "9-source-comments": persisted },
    };
    return {
      status: "complete",
      nextPhase: "10-rules-merge",
      state: advancePhase(next),
    };
  } catch (err) {
    clearProgress(state.repoRoot);
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
