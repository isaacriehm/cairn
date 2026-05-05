/**
 * Phase 12-multidev — detect per-host package manager(s) and emit
 * JOIN.md hints for new contributors.
 *
 * No filesystem mutation outside the result payload. The `.cairn/`
 * skeleton + `.attested-commits` seeding moved to phase 3b-seed; the
 * Claude Code SessionStart bootstrap banner replaces the old
 * `package.json` `prepare` patching path. Idempotent.
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
