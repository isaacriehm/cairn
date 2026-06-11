/**
 * Phase 11-baseline — first sensor sweep against the synthetic
 * full-tree diff. Stamps the audit row counts under outputs so the
 * skill driver can summarize "N findings across M sensors".
 */

import {
  defaultBaselineLanguages,
  runBaselineAudit,
  type BaselineAuditResult,
} from "../baseline-audit.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase11Baseline(state: PhaseState): Promise<PhaseResult> {
  const detection = state.outputs["1-detect"];
  const languages = defaultBaselineLanguages(
    (detection?.stack_signatures ?? []).map((s) => s.kind as string),
  );

  try {
    const result: BaselineAuditResult = await runBaselineAudit({
      repoRoot: state.repoRoot,
      languages,
    });
    const next: PhaseState = {
      ...state,
      outputs: { ...state.outputs, "11-baseline": result },
    };
    return {
      status: "complete",
      nextPhase: "13-multidev",
      state: advancePhase(next),
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "baseline-failed",
        message: "Baseline sensor sweep failed",
        detail: err instanceof Error ? err.stack ?? err.message : String(err),
      },
      state,
    };
  }
}
