/**
 * Phase 13-multidev — detect per-host package manager(s) and emit
 * JOIN.md hints for new contributors. Idempotent.
 */

import {
  installMultiDev,
  type MultiDevInstallResult,
} from "../multi-dev/index.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase13Multidev(state: PhaseState): Promise<PhaseResult> {
  try {
    const result: MultiDevInstallResult = installMultiDev({
      repoRoot: state.repoRoot,
    });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "13-multidev": result },
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
