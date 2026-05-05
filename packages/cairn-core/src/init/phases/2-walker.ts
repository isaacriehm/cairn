/**
 * Phase 2-walker — repo summary scan.
 *
 * Synchronous file walk producing manifest previews, by-extension
 * counts, framework signals, etc. Feeds the mapper (3) + pilot (4).
 */

import { buildRepoSummary } from "../walker.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase2Walker(state: PhaseState): Promise<PhaseResult> {
  try {
    const summary = buildRepoSummary({ repoRoot: state.repoRoot });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "2-walker": summary },
    };
    return {
      status: "complete",
      nextPhase: "3-mapper",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "walker-failed",
        message: "Failed to summarize repo layout",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
