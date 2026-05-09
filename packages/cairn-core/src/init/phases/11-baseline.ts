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
import type { DetectionResult } from "../types.js";
import type { ProjectGlobs } from "../../sensors/types.js";
import type { MapperResultPersisted } from "./mapper-output-io.js";
import { advancePhase } from "./orchestrator.js";
import type { PhaseResult, PhaseState } from "./types.js";

export async function runPhase11Baseline(state: PhaseState): Promise<PhaseResult> {
  const detection = state.outputs["1-detect"] as DetectionResult | undefined;
  const mapper = state.outputs["3-mapper"] as
    | MapperResultPersisted
    | undefined;
  const globs: ProjectGlobs = mapper
    ? {
        route_handler_globs: mapper.output.route_handler_globs,
        dto_globs: mapper.output.dto_globs,
        generator_source_globs: mapper.output.generator_source_globs,
        high_stakes_globs: mapper.output.high_stakes_globs,
        off_limits: mapper.output.off_limits_globs,
      }
    : {};
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
      nextPhase: "12-strip",
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
