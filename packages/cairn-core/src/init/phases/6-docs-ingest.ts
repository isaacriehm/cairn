/**
 * Phase 6-docs-ingest — staged docs ingestion.
 *
 * Wraps `runDocsIngestion`; no operator input. The skill driver
 * surfaces the resulting `decsWritten.length` (drafts in `_inbox/`) in
 * the post-init summary so the operator sees how many docs-source
 * decision drafts landed for triage.
 *
 * Heartbeat: stamps the staged phase id so the statusline can
 * distinguish "still on Stage-1 file filter" from "now on Stage-2
 * section classify". Stage 1 is fast (~37s on gcb-platform); Stage 2
 * is the larger window (~36s in the redesigned path).
 */

import { runDocsIngestion, type IngestionResult } from "../ingest-docs.js";
import { clearProgress, writeProgress } from "../progress.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase6DocsIngest(state: PhaseState): Promise<PhaseResult> {
  const startedAt = Date.now();
  try {
    const result: IngestionResult = await runDocsIngestion({
      repoRoot: state.repoRoot,
      onChunkProgress: (row) => {
        writeProgress(state.repoRoot, {
          phase: `6-docs-ingest:${row.stage}`,
          batch: row.entriesDone,
          total: row.totalEntries,
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
