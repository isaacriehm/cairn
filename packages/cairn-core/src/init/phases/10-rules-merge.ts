/**
 * Phase 10-rules-merge — collapsed to a no-op in v0.9.0.
 *
 * The unified curator pipeline (Phase 9a/9b/9c) now subsumes rule-file
 * section ingestion alongside source comments and docs. This runner
 * stays registered so resumes from old `init-state.json` files still
 * flow through the state machine — it stamps a marker output and
 * advances to `11-baseline`.
 */

import { advancePhase } from "./orchestrator.js";
import type { NoopPhaseOutput, PhaseResult, PhaseState } from "./types.js";

export async function runPhase10RulesMerge(state: PhaseState): Promise<PhaseResult> {
  const out: NoopPhaseOutput = { skipped: "merged-into-9-curator" };
  const next: PhaseState = {
    ...state,
    outputs: { ...state.outputs, "10-rules-merge": out },
  };
  return {
    status: "complete",
    nextPhase: "11-baseline",
    state: advancePhase(next),
  };
}
