/**
 * Phase 12-multidev — install per-clone enforcement (git hooks +
 * package.json prepare patch + .attested-commits seed). Idempotent;
 * re-running is safe.
 */

import {
  installMultiDev,
  type MultiDevInstallResult,
} from "../multi-dev/index.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase12Multidev(state: PhaseState): Promise<PhaseResult> {
  try {
    const result: MultiDevInstallResult = installMultiDev({
      repoRoot: state.repoRoot,
    });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "12-multidev": result },
    };
    return {
      status: "complete",
      nextPhase: null,
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "multidev-failed",
        message: "Multi-dev install failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
