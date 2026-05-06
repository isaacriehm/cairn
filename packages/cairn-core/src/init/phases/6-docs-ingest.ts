/**
 * Phase 6-docs-ingest — emit verbatim DECs for topic-index entries
 * whose SoT lives under `docs/*`.
 *
 * Wraps `runDocsIngestion`; no operator input. The skill driver
 * surfaces the resulting `decsWritten.length` in the post-init summary
 * so the operator sees how many doc-paragraph DECs landed.
 */

import { runDocsIngestion, type IngestionResult } from "../ingest-docs.js";
import { clearProgress, writeProgress } from "../progress.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase6DocsIngest(state: PhaseState): Promise<PhaseResult> {
  const startedAt = Date.now();
  let completed = 0;
  try {
    const result: IngestionResult = await runDocsIngestion({
      repoRoot: state.repoRoot,
      onEntryProgress: (row) => {
        completed += 1;
        writeProgress(state.repoRoot, {
          phase: "6-docs-ingest",
          batch: completed,
          total: row.total,
          startedAt,
        });
      },
    });
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "6-docs-ingest": result },
    };
    return {
      status: "complete",
      nextPhase: "7b-source-comments",
      state: advancePhase(next),
    };
  } catch (err) {
    clearProgress(state.repoRoot);
    return {
      status: "error",
      error: {
        code: "docs-ingest-failed",
        message: "Docs ingestion pipeline failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
