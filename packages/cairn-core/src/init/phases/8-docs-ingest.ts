/**
 * Phase 8-docs-ingest — staged docs ingestion.
 *
 * Wraps `runDocsIngestion`; no operator input. The skill driver
 * surfaces the resulting `decsWritten.length` (drafts in `_inbox/`) in
 * the post-init summary so the operator sees how many docs-source
 * decision drafts landed for triage.
 */

import { runDocsIngestion, type IngestionResult } from "../ingest-docs.js";
import { clearProgress, writeProgress } from "../progress.js";
import { advancePhase, isSelfAdoptState } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase8DocsIngest(state: PhaseState): Promise<PhaseResult> {
  if (isSelfAdoptState(state)) {
    const skipped: IngestionResult = { skipped: "self-adopt" as const };
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "8-docs-ingest": skipped },
    };
    return {
      status: "complete",
      nextPhase: "9-source-comments",
      state: advancePhase(next),
    };
  }
  const startedAt = Date.now();
  try {
    const result: IngestionResult = await runDocsIngestion({
      repoRoot: state.repoRoot,
      onChunkProgress: (row) => {
        writeProgress(state.repoRoot, {
          phase: `8-docs-ingest:${row.stage}`,
          batch: row.entriesDone,
          total: row.totalEntries,
          startedAt,
        });
      },
    });
    clearProgress(state.repoRoot);
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "8-docs-ingest": result },
    };
    return {
      status: "complete",
      nextPhase: "9-source-comments",
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
