/**
 * Phase 8-docs-ingest — collapsed to a no-op in v0.9.0.
 *
 * The unified curator pipeline (Phase 9a/9b/9c) now subsumes docs
 * ingestion alongside source comments and rule-file sections. This
 * runner stays registered so resumes from old `init-state.json` files
 * still flow through the state machine — it stamps a marker output
 * and advances to `9a-walker`.
 */

import { advancePhase } from "./orchestrator.js";
import type { NoopPhaseOutput, PhaseResult, PhaseState } from "./types.js";

export async function runPhase8DocsIngest(state: PhaseState): Promise<PhaseResult> {
  const out: NoopPhaseOutput = { skipped: "merged-into-9-curator" };
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "8-docs-ingest": out },
  };
  return {
    status: "complete",
    nextPhase: "9a-walker",
    state: advancePhase(next),
  };
}
