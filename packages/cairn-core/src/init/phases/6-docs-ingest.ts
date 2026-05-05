/**
 * Phase 6-docs-ingest — Haiku batch over README + docs/ → DEC drafts
 * + canonical-map topics + voice rewrites.
 *
 * Wraps `runDocsIngestion`; no operator input. The skill driver
 * surfaces the resulting `decDraftsWritten` count in the post-init
 * summary so the operator knows how much pending attention they
 * have.
 */

import { runDocsIngestion, type IngestionResult } from "../ingest-docs.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase6DocsIngest(state: PhaseState): Promise<PhaseResult> {
  try {
    const result: IngestionResult = await runDocsIngestion({
      repoRoot: state.repoRoot,
    });
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
