/**
 * Phase 1-detect — synchronous environment + stack signature scan.
 *
 * Wraps `detectAll` in the PhaseResult contract. No operator input;
 * always advances. Output stamped under `state.outputs["1-detect"]`
 * is the full DetectionResult so downstream phases can read repo_root,
 * stack, sensors, etc. without re-detecting.
 */

import { detectAll } from "../detect.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase1Detect(state: PhaseState): Promise<PhaseResult> {
  try {
    const detection = await detectAll({ repoRoot: state.repoRoot });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "1-detect": detection },
    };
    return {
      status: "complete",
      nextPhase: "2-walker",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "detect-failed",
        message: "Failed to scan project environment",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
